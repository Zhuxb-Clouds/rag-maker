import "reflect-metadata";
import crypto from "node:crypto";
import express from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
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

  // ─── 6. Create MCP server ───
  const mcpServer = createMcpServer(ctx);

  // ─── 7. Start transport ───
  if (config.mcpTransport === "stdio") {
    log.info("Starting MCP server with stdio transport");
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
  } else {
    // HTTP mode: Express app with SSE transport + webhook endpoints
    const app = express();
    app.use(express.json());

    // SSE endpoint for MCP
    const transports: Map<string, SSEServerTransport> = new Map();

    app.get("/sse", async (req, res) => {
      const transport = new SSEServerTransport("/messages", res);
      transports.set(transport.sessionId, transport);
      res.on("close", () => {
        transports.delete(transport.sessionId);
      });
      await mcpServer.connect(transport);
    });

    app.post("/messages", async (req, res) => {
      const sessionId = req.query.sessionId as string;
      const transport = transports.get(sessionId);
      if (transport) {
        await transport.handlePostMessage(req, res);
      } else {
        res.status(400).send("Unknown session");
      }
    });

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
      });
    });

    app.listen(config.server.port, config.server.host, () => {
      log.info({ port: config.server.port, host: config.server.host }, "HTTP server started");
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
  log.fatal({ error }, "Fatal error");
  process.exit(1);
});
