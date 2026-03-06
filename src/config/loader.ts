import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "js-yaml";
import { AppConfigSchema, type AppConfig } from "./schema.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("config");

const DEFAULT_CONFIG_PATHS = ["config/sources.yaml", "config/sources.yml", "config/sources.json"];

/**
 * Load and validate application configuration.
 * Priority: explicit path > env RAG_CONFIG_PATH > default paths.
 */
export function loadConfig(configPath?: string): AppConfig {
  const paths = configPath
    ? [configPath]
    : process.env.RAG_CONFIG_PATH
      ? [process.env.RAG_CONFIG_PATH]
      : DEFAULT_CONFIG_PATHS;

  for (const p of paths) {
    const absPath = resolve(p);
    if (existsSync(absPath)) {
      log.info({ path: absPath }, "Loading config");
      const raw = readFileSync(absPath, "utf-8");
      const parsed = p.endsWith(".json") ? JSON.parse(raw) : YAML.load(raw);
      const config = AppConfigSchema.parse(parsed);
      log.info({ sources: config.sources.length, transport: config.mcpTransport }, "Config loaded");
      return config;
    }
  }

  // No config file found — return defaults (empty sources)
  log.warn("No config file found, using defaults");
  return AppConfigSchema.parse({});
}
