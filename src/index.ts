import "reflect-metadata";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config/loader.js";
import { createEmbeddingProvider } from "./embedding/index.js";
import { VectorStore } from "./vectordb/store.js";
import { SourceManager } from "./sources/manager.js";
import { createMcpServer } from "./mcp/server.js";
import { startScheduler, stopScheduler, triggerSync } from "./pipeline/scheduler.js";
import { syncAll, type SyncContext } from "./pipeline/sync.js";
import { createChildLogger } from "./utils/logger.js";

const log = createChildLogger("main");

async function main() {
  log.info("Starting rag-maker...");

  // ─── 1. Load configuration ───
  const config = loadConfig();

  // ─── 2. Initialize embedding provider ───
  const embedder = createEmbeddingProvider(config.embedding);
  log.info({ provider: embedder.name, model: config.embedding.model }, "Embedding provider ready");

  // ─── 3. Initialize LanceDB ───
  const store = new VectorStore(config.databasePath, config.embedding.dimensions);
  await store.initialize();
  await store.createScalarIndexes();

  // ─── 4. Initialize source manager ───
  const sourceManager = new SourceManager(config.statePath);
  sourceManager.initialize(config.sources);

  // ─── 5. Build sync context ───
  const ctx: SyncContext = { config, embedder, store, sourceManager };

  // ─── 6. Create MCP server (only for stdio mode; HTTP mode creates per-session) ───

  // ─── 7. Start transport ───
  if (config.mcpTransport === "stdio") {
    log.info("Starting MCP server with stdio transport");
    const mcpServer = createMcpServer(ctx);
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
  } else {
    // HTTP mode: Express app with Streamable HTTP transport + webhook endpoints
    const app = express();
    app.use(cors());
    app.use(express.json());

    // ─── Session management ───
    const transports = new Map<string, StreamableHTTPServerTransport>();

    /**
     * MCP POST handler — handles initialization and subsequent JSON-RPC requests.
     * @param scopedSourceId - When set, creates a scoped MCP server for this source only.
     */
    const handleMcpPost = async (
      req: express.Request,
      res: express.Response,
      scopedSourceId?: string,
    ) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      try {
        if (sessionId && transports.has(sessionId)) {
          // Existing session — forward to its transport
          await transports.get(sessionId)!.handleRequest(req, res, req.body);
        } else if (!sessionId && isInitializeRequest(req.body)) {
          // New session initialization
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              transports.set(sid, transport);
              log.info(
                { sessionId: sid, scopedSourceId: scopedSourceId ?? "all" },
                "MCP session initialized",
              );
            },
          });

          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid) {
              transports.delete(sid);
              log.info({ sessionId: sid }, "MCP session closed");
            }
          };

          // Create MCP server (scoped or full) and connect transport
          const server = createMcpServer(ctx, scopedSourceId);
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } else {
          res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: No valid session ID provided" },
            id: null,
          });
        }
      } catch (error) {
        log.error({ error }, "Error handling MCP POST request");
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    };

    /** MCP GET handler — SSE stream for server-initiated notifications. */
    const handleMcpGet = async (req: express.Request, res: express.Response) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !transports.has(sessionId)) {
        res.status(400).send("Invalid or missing session ID");
        return;
      }
      await transports.get(sessionId)!.handleRequest(req, res);
    };

    /** MCP DELETE handler — session termination. */
    const handleMcpDelete = async (req: express.Request, res: express.Response) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId || !transports.has(sessionId)) {
        res.status(400).send("Invalid or missing session ID");
        return;
      }
      try {
        await transports.get(sessionId)!.handleRequest(req, res);
      } catch (error) {
        log.error({ error }, "Error handling session termination");
        if (!res.headersSent) {
          res.status(500).send("Error processing session termination");
        }
      }
    };

    // ─── MCP endpoints (full access) ───
    app.post("/mcp", (req, res) => handleMcpPost(req, res));
    app.get("/mcp", handleMcpGet);
    app.delete("/mcp", handleMcpDelete);

    // ─── MCP endpoints (scoped to a single source) ───
    // Usage: configure MCP client with URL http://host:port/mcp/source/<sourceId>
    app.post("/mcp/source/:sourceId", (req, res) => handleMcpPost(req, res, req.params.sourceId));
    app.get("/mcp/source/:sourceId", handleMcpGet);
    app.delete("/mcp/source/:sourceId", handleMcpDelete);

    // ─── Webhook endpoint ───
    app.post("/webhook/:sourceId", async (req, res) => {
      const { sourceId } = req.params;
      const source = sourceManager.get(sourceId);

      if (!source) {
        res.status(404).json({ error: "Source not found" });
        return;
      }

      // Verify webhook signature if configured
      if (source.config.webhookSecret) {
        const signature = req.headers["x-hub-signature-256"] as string;
        if (!signature) {
          res.status(401).json({ error: "Missing signature" });
          return;
        }

        const hmac = crypto.createHmac("sha256", source.config.webhookSecret);
        const digest = "sha256=" + hmac.update(JSON.stringify(req.body)).digest("hex");
        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
          res.status(401).json({ error: "Invalid signature" });
          return;
        }
      }

      log.info({ source: sourceId }, "Webhook received, triggering sync");
      res.status(200).json({ status: "sync_triggered" });

      // Async sync after response
      triggerSync(sourceId, ctx).catch((err) =>
        log.error({ error: err, source: sourceId }, "Webhook sync failed"),
      );
    });

    // ─── Health check ───
    app.get("/health", async (_req, res) => {
      const stats = await store.getStats();
      res.json({
        status: "ok",
        totalChunks: stats.totalChunks,
        sources: sourceManager.getAll().length,
        activeSessions: transports.size,
      });
    });

    const server = app.listen(config.server.port, config.server.host, () => {
      log.info(
        { port: config.server.port, host: config.server.host },
        "Streamable HTTP server started. Endpoints: /mcp (full), /mcp/source/:id (scoped)",
      );
    });

    // Graceful close of HTTP transports on shutdown
    process.on("SIGINT", async () => {
      for (const [sid, transport] of transports) {
        try {
          await transport.close();
        } catch {
          /* ignore */
        }
      }
      server.close();
    });
  }

  // ─── 8. Start cron scheduler ───
  startScheduler(ctx);

  // ─── 9. Initial sync on startup (async, don't block) ───
  if (config.sources.length > 0) {
    log.info("Running initial sync for all sources...");
    syncAll(ctx).catch((err) => log.error({ error: err }, "Initial sync failed"));
  }

  // ─── Graceful shutdown ───
  const shutdown = async () => {
    log.info("Shutting down...");
    stopScheduler();
    sourceManager.persistStates();
    await store.optimize();
    await store.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log.info("rag-maker is running");
}

main().catch((error) => {
  // LanceDB Rust errors may not have a standard `message`; extract all useful fields.
  const details = {
    message: error?.message ?? String(error),
    code: error?.code,
    name: error?.name,
    stack: error?.stack,
  };
  log.fatal({ error: details }, "Fatal error");
  process.exit(1);
});
