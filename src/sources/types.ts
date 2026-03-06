import type { DocumentSourceConfig } from "../config/schema.js";

/** Runtime state of a document source. */
export interface SourceState {
  id: string;
  status: "idle" | "syncing" | "error";
  lastSyncedAt: string | null;
  lastCommitHash: string | null;
  lastError: string | null;
  /** Content hashes of indexed files for change detection */
  fileHashes: Record<string, string>;
}

/** Combined source config + runtime state. */
export interface ManagedSource {
  config: DocumentSourceConfig;
  state: SourceState;
}

/** File change detected during sync. */
export interface FileChange {
  /** Absolute path to the file */
  absolutePath: string;
  /** Path relative to the source root */
  relativePath: string;
  /** Type of change */
  type: "added" | "modified" | "deleted";
}
