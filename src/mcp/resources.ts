import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SyncContext } from "../pipeline/sync.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("mcp:resources");

/**
 * Register MCP resources on the server.
 * @param scopedSourceId - When set, only show stats for this source.
 */
export function registerResources(
  server: McpServer,
  ctx: SyncContext,
  scopedSourceId?: string,
): void {
  // ─── Index overview resource ───
  server.resource(
    "index-status",
    "status://index",
    {
      description: scopedSourceId
        ? `RAG index status for source '${scopedSourceId}'`
        : "Overview of the RAG index: total chunks, per-source stats, sync status",
      mimeType: "application/json",
    },
    async (uri) => {
      const allSources = ctx.sourceManager.getAll();
      const sources = scopedSourceId
        ? allSources.filter((s) => s.config.id === scopedSourceId)
        : allSources;
      const stats = await ctx.store.getStats();

      const overview = {
        totalChunks: stats.totalChunks,
        totalSources: sources.length,
        enabledSources: sources.filter((s) => s.config.enabled).length,
        sourceCounts: stats.sourceCounts,
        sources: sources.map((s) => ({
          id: s.config.id,
          name: s.config.name,
          type: s.config.type,
          status: s.state.status,
          lastSyncedAt: s.state.lastSyncedAt,
          indexedFiles: Object.keys(s.state.fileHashes).length,
        })),
      };

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(overview, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    },
  );

  log.info("MCP resources registered");
}
