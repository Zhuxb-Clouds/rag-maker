import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SyncContext } from "../pipeline/sync.js";
import { triggerSync } from "../pipeline/scheduler.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("mcp:tools");

/**
 * Register all MCP tools on the server.
 * @param scopedSourceId - When set, restricts all operations to this source only.
 */
export function registerTools(server: McpServer, ctx: SyncContext, scopedSourceId?: string): void {
  // ─── search_documents ───
  server.tool(
    "search_documents",
    scopedSourceId
      ? `Search indexed documents from source '${scopedSourceId}' by semantic query, full-text keyword, or hybrid search`
      : "Search indexed documents by semantic query, full-text keyword, or hybrid search",
    {
      query: z.string().describe("Search query text"),
      topK: z.number().int().positive().max(50).default(5).describe("Number of results to return"),
      ...(scopedSourceId
        ? {}
        : {
            sourceFilter: z.string().optional().describe("Filter results to a specific source ID"),
          }),
      mode: z
        .enum(["vector", "fulltext", "hybrid"])
        .default("vector")
        .describe("Search mode: vector (semantic), fulltext (BM25 keyword), or hybrid"),
    },
    async (params: Record<string, any>) => {
      const { query, topK, mode } = params;
      const sourceFilter: string | undefined = scopedSourceId ?? params.sourceFilter;
      try {
        let results;

        if (mode === "fulltext") {
          results = await ctx.store.fullTextSearch(query, {
            topK,
            sourceFilter,
          });
        } else if (mode === "hybrid") {
          // Hybrid: do both searches and merge
          const queryEmbedding = await ctx.embedder.embed(query);
          const [vectorResults, ftsResults] = await Promise.all([
            ctx.store.search(queryEmbedding, { topK, sourceFilter }),
            ctx.store.fullTextSearch(query, { topK, sourceFilter }),
          ]);

          // Simple merge: combine and deduplicate by id, keeping higher score
          const merged = new Map<string, (typeof vectorResults)[0]>();
          for (const r of vectorResults) {
            merged.set(r.id, r);
          }
          for (const r of ftsResults) {
            const existing = merged.get(r.id);
            if (!existing || r.score > existing.score) {
              merged.set(r.id, r);
            }
          }
          results = Array.from(merged.values())
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
        } else {
          // Default: vector search
          const queryEmbedding = await ctx.embedder.embed(query);
          results = await ctx.store.search(queryEmbedding, {
            topK,
            sourceFilter,
          });
        }

        const formatted = results.map((r) => ({
          text: r.text,
          source: r.source_id,
          file: r.file_path,
          score: Math.round(r.score * 1000) / 1000,
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(formatted, null, 2),
            },
          ],
        };
      } catch (error) {
        log.error({ error }, "search_documents failed");
        return {
          content: [
            {
              type: "text" as const,
              text: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ─── list_sources ───
  server.tool(
    "list_sources",
    scopedSourceId
      ? `Show info for source '${scopedSourceId}'`
      : "List all configured document sources and their sync status",
    {},
    async () => {
      const allSources = ctx.sourceManager.getAll();
      const sources = scopedSourceId
        ? allSources.filter((s) => s.config.id === scopedSourceId)
        : allSources;
      const list = sources.map((s) => ({
        id: s.config.id,
        name: s.config.name,
        type: s.config.type,
        enabled: s.config.enabled,
        status: s.state.status,
        lastSyncedAt: s.state.lastSyncedAt,
        lastError: s.state.lastError,
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(list, null, 2) }],
      };
    },
  );

  // ─── add_source (not available in scoped mode) ───
  if (!scopedSourceId) {
    server.tool(
      "add_source",
      "Add a new document source (git repository or local directory)",
      {
        id: z
          .string()
          .regex(/^[a-zA-Z0-9_-]+$/)
          .describe("Unique source identifier"),
        name: z.string().describe("Human-readable name"),
        type: z.enum(["git", "local"]).describe("Source type"),
        url: z.string().optional().describe("Git repository URL (required for git type)"),
        path: z.string().optional().describe("Local directory path (required for local type)"),
        branch: z.string().default("main").describe("Git branch"),
        cron: z.string().default("0 * * * *").describe("Cron schedule expression"),
      },
      async ({ id, name, type, url, path, branch, cron }) => {
        try {
          const config: any = {
            id,
            name,
            type,
            cron,
            enabled: true,
            include: ["**/*.md", "**/*.txt", "**/*.pdf", "**/*.ts", "**/*.js", "**/*.py"],
            exclude: ["**/node_modules/**", "**/.git/**"],
          };

          if (type === "git") {
            if (!url)
              return {
                content: [
                  { type: "text" as const, text: "Error: url is required for git sources" },
                ],
                isError: true,
              };
            config.url = url;
            config.branch = branch;
            config.depth = 1;
          } else {
            if (!path)
              return {
                content: [
                  { type: "text" as const, text: "Error: path is required for local sources" },
                ],
                isError: true,
              };
            config.path = path;
          }

          ctx.sourceManager.add(config);

          return {
            content: [
              {
                type: "text" as const,
                text: `Source '${id}' added successfully. Use trigger_sync to start indexing.`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to add source: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    );
  } // end add_source

  // ─── remove_source (not available in scoped mode) ───
  if (!scopedSourceId) {
    server.tool(
      "remove_source",
      "Remove a document source and delete all its indexed data",
      {
        sourceId: z.string().describe("Source ID to remove"),
      },
      async ({ sourceId }) => {
        try {
          // Delete vector data
          await ctx.store.deleteBySource(sourceId);
          // Remove from manager
          const removed = ctx.sourceManager.remove(sourceId);

          if (!removed) {
            return {
              content: [{ type: "text" as const, text: `Source '${sourceId}' not found` }],
              isError: true,
            };
          }

          return {
            content: [
              {
                type: "text" as const,
                text: `Source '${sourceId}' removed and all indexed data deleted.`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to remove source: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      },
    );
  } // end remove_source

  // ─── trigger_sync ───
  server.tool(
    "trigger_sync",
    scopedSourceId
      ? `Manually trigger a sync for source '${scopedSourceId}'`
      : "Manually trigger a sync for a specific source or all sources",
    {
      ...(scopedSourceId
        ? {}
        : { sourceId: z.string().optional().describe("Source ID to sync (omit to sync all)") }),
    },
    async (params: Record<string, any>) => {
      const sourceId: string | undefined = scopedSourceId ?? params.sourceId;
      try {
        // Fire the sync (run async, don't block the tool response)
        const syncPromise = triggerSync(sourceId ?? null, ctx);

        if (sourceId) {
          await syncPromise;
          return {
            content: [
              {
                type: "text" as const,
                text: `Sync completed for source '${sourceId}'.`,
              },
            ],
          };
        } else {
          // For all sources, don't wait
          syncPromise.catch((err) => log.error({ error: err }, "Background sync-all failed"));
          return {
            content: [
              {
                type: "text" as const,
                text: "Sync triggered for all sources. Use get_sync_status to check progress.",
              },
            ],
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Sync failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ─── get_sync_status ───
  server.tool(
    "get_sync_status",
    scopedSourceId
      ? `Get the sync status for source '${scopedSourceId}'`
      : "Get the current sync status and index statistics",
    {},
    async () => {
      try {
        const allSources = ctx.sourceManager.getAll();
        const sources = scopedSourceId
          ? allSources.filter((s) => s.config.id === scopedSourceId)
          : allSources;
        const stats = await ctx.store.getStats();

        const status = {
          totalChunks: stats.totalChunks,
          sourceCounts: stats.sourceCounts,
          sources: sources.map((s) => ({
            id: s.config.id,
            name: s.config.name,
            status: s.state.status,
            lastSyncedAt: s.state.lastSyncedAt,
            lastError: s.state.lastError,
            indexedFiles: Object.keys(s.state.fileHashes).length,
          })),
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to get status: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  log.info("MCP tools registered");
}
