import { resolve } from "node:path";
import type { AppConfig } from "../config/schema.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import type { VectorStore, ChunkRecord } from "../vectordb/store.js";
import type { SourceManager } from "../sources/manager.js";
import type { FileChange } from "../sources/types.js";
import { syncGitRepo, getGitChanges, getRepoDir } from "../sources/git-source.js";
import { getLocalChanges } from "../sources/local-source.js";
import { parseFile } from "../parser/router.js";
import { chunkText } from "../chunker/index.js";
import { chunkId } from "../utils/hash.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("pipeline:sync");

/** Active sync locks to prevent concurrent syncs on the same source. */
const activeSyncs = new Set<string>();

/** Pending sync requests while a sync is already running. */
const pendingSyncs = new Set<string>();

export interface SyncContext {
  config: AppConfig;
  embedder: EmbeddingProvider;
  store: VectorStore;
  sourceManager: SourceManager;
}

/**
 * Sync a single source: pull latest → detect changes → parse → chunk → embed → store.
 * Returns the number of chunks indexed.
 */
export async function syncSource(sourceId: string, ctx: SyncContext): Promise<number> {
  const source = ctx.sourceManager.get(sourceId);
  if (!source) {
    log.warn({ source: sourceId }, "Source not found");
    return 0;
  }

  if (!source.config.enabled) {
    log.info({ source: sourceId }, "Source disabled, skipping");
    return 0;
  }

  // Debounce: if already syncing, queue for re-sync after current finishes
  if (activeSyncs.has(sourceId)) {
    log.info({ source: sourceId }, "Sync already in progress, queueing");
    pendingSyncs.add(sourceId);
    return 0;
  }

  activeSyncs.add(sourceId);
  ctx.sourceManager.markSyncing(sourceId);

  try {
    let changes: FileChange[];
    let commitHash: string | undefined;

    if (source.config.type === "git") {
      // Step 1: Pull latest
      commitHash = await syncGitRepo(source.config as any, ctx.config.reposPath);

      // Step 2: Detect changes
      changes = await getGitChanges(
        sourceId,
        ctx.config.reposPath,
        source.state.lastCommitHash,
        source.config.include,
        source.config.exclude,
      );
    } else {
      // Local source
      changes = await getLocalChanges(source.config as any, source.state.fileHashes);
    }

    if (changes.length === 0) {
      log.info({ source: sourceId }, "No changes detected");
      ctx.sourceManager.markSynced(sourceId, commitHash);
      return 0;
    }

    log.info(
      {
        source: sourceId,
        added: changes.filter((c) => c.type === "added").length,
        modified: changes.filter((c) => c.type === "modified").length,
        deleted: changes.filter((c) => c.type === "deleted").length,
      },
      "Processing changes",
    );

    let totalChunks = 0;

    // Step 3: Handle deletions
    const deletions = changes.filter((c) => c.type === "deleted");
    for (const del of deletions) {
      await ctx.store.deleteByFile(sourceId, del.relativePath);
      ctx.sourceManager.removeFileHash(sourceId, del.relativePath);
    }

    // Step 4: Process added/modified files in batches for embedding efficiency
    const upserts = changes.filter((c) => c.type !== "deleted");
    let filesProcessed = 0;
    const totalFiles = upserts.length;

    // Phase 4a: Parse and chunk all files first (fast, no embedding)
    const fileBatches: Array<{
      change: FileChange;
      chunks: import("../chunker/index.js").TextChunk[];
      contentHash: string;
    }> = [];

    for (const change of upserts) {
      try {
        filesProcessed++;

        // Resolve absolute path
        let absolutePath = change.absolutePath;
        if (source.config.type === "git") {
          absolutePath = resolve(getRepoDir(ctx.config.reposPath, sourceId), change.relativePath);
        }

        // Parse the file
        const doc = await parseFile(absolutePath, {
          sourceId,
          filePath: change.relativePath,
        });

        if (!doc || !doc.content.trim()) {
          log.debug({ file: change.relativePath }, "Skipped empty file");
          continue;
        }

        // Chunk the document (AST-aware for TS/JS, text splitting otherwise)
        const chunks = await chunkText(doc.content, ctx.embedder, ctx.config.chunker, doc.metadata);

        fileBatches.push({ change, chunks, contentHash: doc.contentHash });

        if (filesProcessed === 1 || filesProcessed % 10 === 0 || filesProcessed === totalFiles) {
          log.info(
            {
              source: sourceId,
              progress: `${filesProcessed}/${totalFiles}`,
              file: change.relativePath,
              chunks: chunks.length,
            },
            `Parsed ${filesProcessed}/${totalFiles} files`,
          );
        }
      } catch (error) {
        log.error({ err: error, file: change.relativePath }, "Failed to parse file");
      }
    }

    log.info(
      { source: sourceId, files: fileBatches.length, totalFiles },
      "Parse complete, starting embedding",
    );

    // Phase 4b: Batch embed all chunks together for maximum throughput
    // Collect all texts across all files
    const allTexts: string[] = [];
    const fileOffsets: Array<{ startIdx: number; count: number }> = [];
    for (const fb of fileBatches) {
      fileOffsets.push({ startIdx: allTexts.length, count: fb.chunks.length });
      for (const chunk of fb.chunks) {
        allTexts.push(chunk.text);
      }
    }

    log.info(
      { source: sourceId, totalChunksToEmbed: allTexts.length },
      "Embedding all chunks in bulk",
    );

    // Embed everything in one big batch call (internally batched by embedBatch)
    const allEmbeddings = await ctx.embedder.embedBatch(allTexts);

    // Phase 4c: Build records and upsert per file
    for (let fi = 0; fi < fileBatches.length; fi++) {
      const { change, chunks, contentHash } = fileBatches[fi];
      const { startIdx, count } = fileOffsets[fi];
      const embeddings = allEmbeddings.slice(startIdx, startIdx + count);

      try {
        // Delete old chunks for this file before upserting
        await ctx.store.deleteByFile(sourceId, change.relativePath);

        // Build chunk records
        const records: ChunkRecord[] = chunks.map((chunk, idx) => ({
          id: chunkId(sourceId, change.relativePath, idx),
          vector: embeddings[idx],
          text: chunk.text,
          source_id: sourceId,
          file_path: change.relativePath,
          chunk_index: idx,
          content_hash: contentHash,
          created_at: new Date().toISOString(),
        }));

        // Upsert to vector store
        await ctx.store.upsert(records);
        totalChunks += records.length;

        // Update file hash in state
        ctx.sourceManager.updateFileHash(sourceId, change.relativePath, contentHash);

        // Progress logging every 50 files
        if ((fi + 1) % 50 === 0 || fi + 1 === fileBatches.length) {
          log.info(
            {
              source: sourceId,
              progress: `${fi + 1}/${fileBatches.length}`,
              totalChunks,
            },
            `Stored ${fi + 1}/${fileBatches.length} files`,
          );
        }
      } catch (error) {
        log.error({ err: error, file: change.relativePath }, "Failed to store file");
      }
    }

    // Step 5: Optimize after sync
    await ctx.store.optimize();

    // Step 6: Rebuild FTS index after changes
    try {
      await ctx.store.createFtsIndex();
    } catch {
      // FTS index creation may fail if table is empty or being rebuilt
    }

    ctx.sourceManager.markSynced(sourceId, commitHash);
    log.info({ source: sourceId, totalChunks, files: upserts.length }, "Sync complete");

    return totalChunks;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    ctx.sourceManager.markError(sourceId, errMsg);
    log.error({ err: error, source: sourceId }, "Sync failed");
    return 0;
  } finally {
    activeSyncs.delete(sourceId);

    // Process pending re-sync request
    if (pendingSyncs.has(sourceId)) {
      pendingSyncs.delete(sourceId);
      log.info({ source: sourceId }, "Processing queued re-sync");
      // Fire and forget — don't await to avoid deep recursion
      syncSource(sourceId, ctx).catch((err) => {
        log.error({ error: err, source: sourceId }, "Queued re-sync failed");
      });
    }
  }
}

/** Sync all enabled sources. */
export async function syncAll(ctx: SyncContext): Promise<void> {
  const sources = ctx.sourceManager.getAll();
  log.info({ count: sources.length }, "Syncing all sources");

  for (const source of sources) {
    if (!source.config.enabled) continue;
    await syncSource(source.config.id, ctx);
  }
}
