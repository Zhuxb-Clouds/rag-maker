import * as lancedb from "@lancedb/lancedb";
import { Schema, Field, Float32, Utf8, Int32, FixedSizeList } from "apache-arrow";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("vectordb");

const TABLE_NAME = "documents";

/** A document chunk record stored in LanceDB. */
export interface ChunkRecord {
  id: string;
  vector: number[];
  text: string;
  source_id: string;
  file_path: string;
  chunk_index: number;
  content_hash: string;
  created_at: string;
}

/** A search result returned from the vector store. */
export interface SearchResult {
  id: string;
  text: string;
  source_id: string;
  file_path: string;
  chunk_index: number;
  score: number;
}

export class VectorStore {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private dimensions: number;
  private dbPath: string;
  private writeCount = 0;

  constructor(dbPath: string, dimensions: number) {
    this.dbPath = dbPath;
    this.dimensions = dimensions;
  }

  /** Connect to LanceDB and ensure the table exists. */
  async initialize(): Promise<void> {
    log.info({ path: this.dbPath }, "Connecting to LanceDB");
    this.db = await lancedb.connect(this.dbPath);

    const tables = await this.db.tableNames();

    if (tables.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
      log.info("Opened existing documents table");
    } else {
      // Create table with initial seed data so schema is inferred
      const schema = new Schema([
        new Field("id", new Utf8(), false),
        new Field(
          "vector",
          new FixedSizeList(this.dimensions, new Field("item", new Float32(), true)),
          false,
        ),
        new Field("text", new Utf8(), false),
        new Field("source_id", new Utf8(), false),
        new Field("file_path", new Utf8(), false),
        new Field("chunk_index", new Int32(), false),
        new Field("content_hash", new Utf8(), false),
        new Field("created_at", new Utf8(), false),
      ]);
      this.table = await this.db.createEmptyTable(TABLE_NAME, schema);
      log.info({ dimensions: this.dimensions }, "Created documents table");
    }
  }

  /** Upsert chunks into the store. Uses merge-insert on id. */
  async upsert(records: ChunkRecord[]): Promise<void> {
    if (!this.table || records.length === 0) return;

    log.debug({ count: records.length }, "Upserting chunks");

    await this.table
      .mergeInsert("id")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(records as unknown as Record<string, unknown>[]);

    this.writeCount += records.length;

    // Auto-optimize after accumulating enough writes
    if (this.writeCount >= 5000) {
      await this.optimize();
      this.writeCount = 0;
    }
  }

  /** Vector similarity search with optional source filter. */
  async search(
    queryVector: number[],
    options: {
      topK?: number;
      sourceFilter?: string;
    } = {},
  ): Promise<SearchResult[]> {
    if (!this.table) throw new Error("VectorStore not initialized");

    const { topK = 5, sourceFilter } = options;

    let query = this.table.vectorSearch(queryVector).distanceType("cosine").limit(topK);

    if (sourceFilter) {
      query = query.where(`source_id = '${sourceFilter}'`);
    }

    const results = await query.toArray();

    return results.map((row: any) => ({
      id: row.id,
      text: row.text,
      source_id: row.source_id,
      file_path: row.file_path,
      chunk_index: row.chunk_index,
      score: 1 - (row._distance ?? 0), // Convert distance to similarity score
    }));
  }

  /** Full-text search using BM25. Requires FTS index. */
  async fullTextSearch(
    query: string,
    options: {
      topK?: number;
      sourceFilter?: string;
    } = {},
  ): Promise<SearchResult[]> {
    if (!this.table) throw new Error("VectorStore not initialized");

    const { topK = 5, sourceFilter } = options;

    let q = this.table.search(query, "fts").limit(topK);

    if (sourceFilter) {
      q = q.where(`source_id = '${sourceFilter}'`);
    }

    const results = await q.toArray();

    return results.map((row: any) => ({
      id: row.id,
      text: row.text,
      source_id: row.source_id,
      file_path: row.file_path,
      chunk_index: row.chunk_index,
      score: row._score ?? 0,
    }));
  }

  /** Create FTS index on the text column. */
  async createFtsIndex(): Promise<void> {
    if (!this.table) throw new Error("VectorStore not initialized");

    try {
      await this.table.createIndex("text", {
        config: lancedb.Index.fts(),
      });
      log.info("Created FTS index on text column");
    } catch (error: any) {
      // Index may already exist
      if (error.message?.includes("already exists")) {
        log.debug("FTS index already exists");
      } else {
        throw error;
      }
    }
  }

  /** Create scalar index on source_id for faster filtering. */
  async createScalarIndexes(): Promise<void> {
    if (!this.table) throw new Error("VectorStore not initialized");

    try {
      await this.table.createIndex("source_id");
      log.info("Created scalar index on source_id");
    } catch (error: any) {
      if (error.message?.includes("already exists")) {
        log.debug("source_id index already exists");
      } else {
        log.warn({ error }, "Failed to create scalar index on source_id");
      }
    }
  }

  /** Delete all chunks belonging to a specific source. */
  async deleteBySource(sourceId: string): Promise<void> {
    if (!this.table) return;
    log.info({ sourceId }, "Deleting chunks for source");
    await this.table.delete(`source_id = '${sourceId}'`);
  }

  /** Delete chunks for a specific file within a source. */
  async deleteByFile(sourceId: string, filePath: string): Promise<void> {
    if (!this.table) return;
    await this.table.delete(`source_id = '${sourceId}' AND file_path = '${filePath}'`);
  }

  /** Get statistics about the store. */
  async getStats(): Promise<{
    totalChunks: number;
    sourceCounts: Record<string, number>;
  }> {
    if (!this.table) return { totalChunks: 0, sourceCounts: {} };

    const totalChunks = await this.table.countRows();

    // Get per-source counts via query
    const allRows = await this.table.query().select(["source_id"]).toArray();

    const sourceCounts: Record<string, number> = {};
    for (const row of allRows) {
      const sid = (row as any).source_id;
      sourceCounts[sid] = (sourceCounts[sid] ?? 0) + 1;
    }

    return { totalChunks, sourceCounts };
  }

  /** Optimize the table: compact fragments and cleanup old versions. */
  async optimize(): Promise<void> {
    if (!this.table) return;
    log.info("Optimizing LanceDB table");
    try {
      await this.table.optimize();
    } catch (error) {
      log.warn({ error }, "Optimization failed (non-critical)");
    }
  }

  /** Close the database connection. */
  async close(): Promise<void> {
    this.table = null;
    this.db = null;
    log.info("VectorStore closed");
  }
}
