import type { EmbeddingProvider } from "../embedding/provider.js";
import type { ChunkerConfig } from "../config/schema.js";
import { semanticChunk, type TextChunk } from "./semantic-chunker.js";
import { fallbackChunk } from "./fallback-chunker.js";
import { createChildLogger } from "../utils/logger.js";

export type { TextChunk } from "./semantic-chunker.js";

const log = createChildLogger("chunker");

/**
 * Minimum text length (chars) to attempt semantic chunking.
 * Semantic chunking embeds every sentence — expensive on CPU.
 * Set high to avoid using it on bulk syncs; override with env SEMANTIC_MIN_LENGTH.
 */
const SEMANTIC_MIN_LENGTH = Number(process.env.SEMANTIC_MIN_LENGTH) || 50_000;

/**
 * Chunk text with configurable strategy.
 *
 * Strategy:
 * 1. Very short text → single chunk
 * 2. Text >= SEMANTIC_MIN_LENGTH and semantic enabled → semantic chunking (embedding-based)
 * 3. Otherwise → RecursiveCharacterTextSplitter (fast, no embedding needed for splitting)
 */
export async function chunkText(
  text: string,
  embedder: EmbeddingProvider,
  config: ChunkerConfig,
): Promise<TextChunk[]> {
  // Very short text — return as single chunk
  if (text.trim().length < 100) {
    return [{ text: text.trim(), index: 0 }];
  }

  // Semantic chunking only for very long texts (expensive: embeds every sentence)
  if (text.length >= SEMANTIC_MIN_LENGTH) {
    try {
      const chunks = await semanticChunk(text, embedder, {
        similarityThresholdPercentile: config.similarityThresholdPercentile,
        maxChunkSize: config.maxChunkSize,
        minChunkSentences: config.minChunkSentences,
      });

      if (chunks.length > 0) {
        log.debug({ chunks: chunks.length }, "Used semantic chunking");
        return chunks;
      }
    } catch (error) {
      log.warn({ err: error }, "Semantic chunking failed, falling back");
    }
  }

  // Fast fallback — pure text splitting, no extra embedding calls
  const chunks = await fallbackChunk(text, {
    maxChunkSize: config.maxChunkSize,
    chunkOverlap: config.chunkOverlap,
  });

  log.debug({ chunks: chunks.length }, "Used fallback chunking");
  return chunks;
}
