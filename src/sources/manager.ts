import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { DocumentSourceConfig } from "../config/schema.js";
import type { ManagedSource, SourceState } from "./types.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("source:manager");

/** Manages all document sources and their persistent state. */
export class SourceManager {
  private sources: Map<string, ManagedSource> = new Map();
  private statePath: string;

  constructor(statePath: string) {
    this.statePath = resolve(statePath);
  }

  /** Load state from disk and merge with config sources. */
  initialize(sourceConfigs: DocumentSourceConfig[]): void {
    const savedStates = this.loadStates();

    for (const config of sourceConfigs) {
      const existingState = savedStates[config.id];
      this.sources.set(config.id, {
        config,
        state: existingState ?? createDefaultState(config.id),
      });
    }

    log.info({ count: this.sources.size }, "Source manager initialized");
  }

  /** Get all managed sources. */
  getAll(): ManagedSource[] {
    return Array.from(this.sources.values());
  }

  /** Get a specific source by ID. */
  get(sourceId: string): ManagedSource | undefined {
    return this.sources.get(sourceId);
  }

  /** Add a new source at runtime. */
  add(config: DocumentSourceConfig): void {
    if (this.sources.has(config.id)) {
      throw new Error(`Source '${config.id}' already exists`);
    }
    this.sources.set(config.id, {
      config,
      state: createDefaultState(config.id),
    });
    this.persistStates();
    log.info({ source: config.id }, "Source added");
  }

  /** Remove a source. */
  remove(sourceId: string): boolean {
    const deleted = this.sources.delete(sourceId);
    if (deleted) {
      this.persistStates();
      log.info({ source: sourceId }, "Source removed");
    }
    return deleted;
  }

  /** Update the state of a source. */
  updateState(sourceId: string, update: Partial<SourceState>): void {
    const source = this.sources.get(sourceId);
    if (!source) return;
    Object.assign(source.state, update);
    this.persistStates();
  }

  /** Mark a source as syncing. */
  markSyncing(sourceId: string): void {
    this.updateState(sourceId, { status: "syncing", lastError: null });
  }

  /** Mark a source as completed syncing. */
  markSynced(sourceId: string, commitHash?: string): void {
    this.updateState(sourceId, {
      status: "idle",
      lastSyncedAt: new Date().toISOString(),
      lastCommitHash: commitHash ?? null,
      lastError: null,
    });
  }

  /** Mark a source as errored. */
  markError(sourceId: string, error: string): void {
    this.updateState(sourceId, {
      status: "error",
      lastError: error,
    });
  }

  /** Update the file hash map for a source. */
  updateFileHash(sourceId: string, filePath: string, hash: string): void {
    const source = this.sources.get(sourceId);
    if (!source) return;
    source.state.fileHashes[filePath] = hash;
  }

  /** Remove a file hash entry. */
  removeFileHash(sourceId: string, filePath: string): void {
    const source = this.sources.get(sourceId);
    if (!source) return;
    delete source.state.fileHashes[filePath];
  }

  /** Persist all source states to disk. */
  persistStates(): void {
    const states: Record<string, SourceState> = {};
    for (const [id, source] of this.sources) {
      states[id] = source.state;
    }
    const dir = dirname(this.statePath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(states, null, 2));
  }

  /** Load source states from disk. */
  private loadStates(): Record<string, SourceState> {
    if (!existsSync(this.statePath)) return {};
    try {
      const raw = readFileSync(this.statePath, "utf-8");
      return JSON.parse(raw);
    } catch (error) {
      log.warn({ error }, "Failed to load source states");
      return {};
    }
  }
}

function createDefaultState(sourceId: string): SourceState {
  return {
    id: sourceId,
    status: "idle",
    lastSyncedAt: null,
    lastCommitHash: null,
    lastError: null,
    fileHashes: {},
  };
}
