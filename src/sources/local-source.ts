import { resolve } from "node:path";
import { stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { DocumentSourceConfig } from "../config/schema.js";
import type { FileChange, SourceState } from "./types.js";
import { contentHash } from "../utils/hash.js";
import { createChildLogger } from "../utils/logger.js";
import { readFile } from "node:fs/promises";

const log = createChildLogger("source:local");

/**
 * Scan a local directory for files, detecting changes via content hash comparison.
 */
export async function getLocalChanges(
  config: DocumentSourceConfig & { type: "local" },
  previousHashes: Record<string, string>,
): Promise<FileChange[]> {
  const rootDir = resolve(config.path);

  if (!existsSync(rootDir)) {
    log.error({ path: rootDir }, "Local source directory does not exist");
    return [];
  }

  const changes: FileChange[] = [];
  const currentFiles = new Set<string>();

  await walkDir(
    rootDir,
    rootDir,
    config.include,
    config.exclude,
    async (absolutePath, relativePath) => {
      currentFiles.add(relativePath);

      try {
        const content = await readFile(absolutePath, "utf-8");
        const hash = contentHash(content);

        if (!previousHashes[relativePath]) {
          changes.push({ absolutePath, relativePath, type: "added" });
        } else if (previousHashes[relativePath] !== hash) {
          changes.push({ absolutePath, relativePath, type: "modified" });
        }
        // else: unchanged — skip
      } catch {
        // Binary file or read error — try to detect change by mtime
        const fileStat = await stat(absolutePath);
        const mtimeKey = fileStat.mtime.toISOString();
        if (previousHashes[relativePath] !== mtimeKey) {
          changes.push({
            absolutePath,
            relativePath,
            type: previousHashes[relativePath] ? "modified" : "added",
          });
        }
      }
    },
  );

  // Detect deletions
  for (const prevFile of Object.keys(previousHashes)) {
    if (!currentFiles.has(prevFile)) {
      changes.push({
        absolutePath: resolve(rootDir, prevFile),
        relativePath: prevFile,
        type: "deleted",
      });
    }
  }

  log.info({ source: config.id, changes: changes.length }, "Local scan complete");
  return changes;
}

/** Recursively walk a directory, calling callback for matching files. */
async function walkDir(
  dir: string,
  rootDir: string,
  includeGlobs: string[],
  excludeGlobs: string[],
  callback: (absolutePath: string, relativePath: string) => Promise<void>,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = resolve(dir, entry.name);
    const relativePath = absolutePath.slice(rootDir.length + 1);

    if (entry.isDirectory()) {
      // Check if directory should be excluded
      if (shouldExclude(relativePath + "/", excludeGlobs)) continue;
      await walkDir(absolutePath, rootDir, includeGlobs, excludeGlobs, callback);
    } else if (entry.isFile()) {
      if (shouldExclude(relativePath, excludeGlobs)) continue;
      if (!matchesInclude(relativePath, includeGlobs)) continue;
      await callback(absolutePath, relativePath);
    }
  }
}

function shouldExclude(path: string, excludeGlobs: string[]): boolean {
  return excludeGlobs.some((pattern) => {
    const dir = pattern.replace(/\*\*/g, "").replace(/\//g, "");
    if (!dir) return false;
    return path.includes(dir);
  });
}

function matchesInclude(path: string, includeGlobs: string[]): boolean {
  if (includeGlobs.length === 0) return true;
  return includeGlobs.some((pattern) => {
    if (pattern.startsWith("**/*.")) {
      const ext = pattern.slice(4); // "**/*.md" -> ".md"
      return path.endsWith(ext);
    }
    return true;
  });
}
