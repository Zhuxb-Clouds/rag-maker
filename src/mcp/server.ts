import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SyncContext } from "../pipeline/sync.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("mcp:server");

/**
 * Create and configure the MCP server with all tools and resources.
 * @param ctx - Sync context with embedder, store, source manager, etc.
 * @param scopedSourceId - Optional source ID to restrict all operations to a single source.
 *                         When set, search results and tool operations are scoped to this source only.
 */
export function createMcpServer(ctx: SyncContext, scopedSourceId?: string): McpServer {
  const server = new McpServer({
    name: scopedSourceId ? `rag-maker [${scopedSourceId}]` : "rag-maker",
    version: "0.1.0",
  });

  registerTools(server, ctx, scopedSourceId);
  registerResources(server, ctx, scopedSourceId);

  log.info({ scopedSourceId: scopedSourceId ?? "none" }, "MCP server created");
  return server;
}
