import { resolve, join, relative } from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { simpleGit, type SimpleGit } from "simple-git";
import type { DocumentSourceConfig } from "../config/schema.js";
import type { FileChange, SourceState } from "./types.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("source:git");

/** Get the local directory path for a git source. */
export function getRepoDir(reposPath: string, sourceId: string): string {
  return resolve(reposPath, sourceId);
}

/** Clone or pull a git repository. Returns the current HEAD commit hash. */
export async function syncGitRepo(
  config: DocumentSourceConfig & { type: "git" },
  reposPath: string,
): Promise<string> {
  const repoDir = getRepoDir(reposPath, config.id);
  await mkdir(repoDir, { recursive: true });

  let git: SimpleGit;

  if (existsSync(join(repoDir, ".git"))) {
    // Repo already exists — pull
    git = simpleGit(repoDir);
    log.info({ source: config.id, branch: config.branch }, "Pulling latest");
    await git.pull("origin", config.branch);
  } else {
    // Fresh clone
    log.info({ source: config.id, url: config.url, branch: config.branch }, "Cloning");

    let cloneUrl = config.url;
    if (config.auth?.token) {
      // Inject token into HTTPS URL
      const url = new URL(config.url);
      url.username = config.auth.token;
      cloneUrl = url.toString();
    }

    const parentGit = simpleGit();
    await parentGit.clone(cloneUrl, repoDir, [
      "--branch",
      config.branch,
      "--depth",
      String(config.depth),
      "--single-branch",
    ]);
    git = simpleGit(repoDir);
  }

  const logResult = await git.log({ maxCount: 1 });
  const commitHash = logResult.latest?.hash ?? "unknown";
  log.info({ source: config.id, commit: commitHash }, "Git sync complete");
  return commitHash;
}

/**
 * Get files that changed since a given commit hash.
 * If no previous commit is known, returns all tracked files.
 */
export async function getGitChanges(
  sourceId: string,
  reposPath: string,
  previousCommitHash: string | null,
  includeGlobs: string[],
  excludeGlobs: string[],
): Promise<FileChange[]> {
  const repoDir = getRepoDir(reposPath, sourceId);
  const git = simpleGit(repoDir);

  if (!previousCommitHash) {
    // Full scan — return all files
    log.info({ source: sourceId }, "Full scan (no previous commit)");
    return await getAllFiles(repoDir, includeGlobs, excludeGlobs);
  }

  try {
    const diff = await git.diffSummary([previousCommitHash, "HEAD"]);

    const changes: FileChange[] = [];
    for (const file of diff.files) {
      // file.file is relative path
      const filePath = (file as any).file as string;
      if (!matchesGlobs(filePath, includeGlobs, excludeGlobs)) continue;

      const absolutePath = resolve(repoDir, filePath);
      if ("binary" in file && file.binary) continue; // skip binary files

      const insertions = "insertions" in file ? file.insertions : 0;
      const deletions = "deletions" in file ? file.deletions : 0;

      if (insertions === 0 && deletions > 0) {
        // Likely deleted
        changes.push({ absolutePath, relativePath: filePath, type: "deleted" });
      } else if (existsSync(absolutePath)) {
        changes.push({ absolutePath, relativePath: filePath, type: "modified" });
      } else {
        changes.push({ absolutePath, relativePath: filePath, type: "deleted" });
      }
    }

    log.info({ source: sourceId, changes: changes.length }, "Detected git changes");
    return changes;
  } catch (error) {
    // If diff fails (e.g., commit no longer reachable), do full scan
    log.warn({ error, source: sourceId }, "Git diff failed, doing full scan");
    return await getAllFiles(repoDir, includeGlobs, excludeGlobs);
  }
}

/** Get all files in the repo matching glob patterns. */
async function getAllFiles(
  repoDir: string,
  includeGlobs: string[],
  excludeGlobs: string[],
): Promise<FileChange[]> {
  const { readdir } = await import("node:fs/promises");

  // Recursively collect all files
  const allPaths: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(resolve(dir, entry.name), relPath);
      } else {
        allPaths.push(relPath);
      }
    }
  };
  await walk(repoDir, "");

  const files: FileChange[] = [];
  for (const relPath of allPaths) {
    if (!matchesGlobs(relPath, includeGlobs, excludeGlobs)) continue;
    files.push({
      absolutePath: resolve(repoDir, relPath),
      relativePath: relPath,
      type: "added",
    });
  }

  return files;
}

/** Check if a path matches include globs and doesn't match exclude globs. */
function matchesGlobs(filePath: string, includeGlobs: string[], excludeGlobs: string[]): boolean {
  if (matchesExclude(filePath, excludeGlobs)) return false;
  // Simple extension-based matching for include patterns
  return includeGlobs.some((pattern) => {
    if (pattern.startsWith("**/*.")) {
      const ext = pattern.slice(4); // e.g., "**/*.md" -> ".md"
      return filePath.endsWith(ext);
    }
    return true;
  });
}

function matchesExclude(filePath: string, excludeGlobs: string[]): boolean {
  return excludeGlobs.some((pattern) => {
    // Simple pattern matching for common excludes
    const dir = pattern.replace(/\*\*/g, "").replace(/\//g, "");
    return filePath.includes(dir);
  });
}
