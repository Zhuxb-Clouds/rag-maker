import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SyncContext } from "../pipeline/sync.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("mcp:server");

/** Create and configure the MCP server with all tools and resources. */
export function createMcpServer(ctx: SyncContext): McpServer {
  const server = new McpServer({
    name: "rag-maker",
    version: "0.1.0",
  });

  registerTools(server, ctx);
  registerResources(server, ctx);

  log.info("MCP server created");
  return server;
}
