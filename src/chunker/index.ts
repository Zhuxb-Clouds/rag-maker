import type { EmbeddingProvider } from "../embedding/provider.js";
import type { ChunkerConfig } from "../config/schema.js";
import type { DocumentMetadata } from "../parser/types.js";
import { semanticChunk, type TextChunk } from "./semantic-chunker.js";
import { fallbackChunk } from "./fallback-chunker.js";
import { astChunkTypeScript } from "./ast-chunker.js";
import { createChildLogger } from "../utils/logger.js";

export type { TextChunk } from "./semantic-chunker.js";

const log = createChildLogger("chunker");

/**
 * Minimum text length (chars) to attempt semantic chunking.
 * Semantic chunking embeds every sentence — expensive on CPU.
 * Set high to avoid using it on bulk syncs; override with env SEMANTIC_MIN_LENGTH.
 */
const SEMANTIC_MIN_LENGTH = Number(process.env.SEMANTIC_MIN_LENGTH) || 50_000;

/** Languages supported by the AST chunker. */
const AST_LANGUAGES = new Set(["typescript", "javascript"]);

/**
 * Chunk text with configurable strategy.
 *
 * Strategy:
 * 0. TypeScript / JavaScript code → AST-based structural chunking
 * 1. Very short text → single chunk
 * 2. Text >= SEMANTIC_MIN_LENGTH and semantic enabled → semantic chunking (embedding-based)
 * 3. Otherwise → RecursiveCharacterTextSplitter (fast, no embedding needed for splitting)
 */
export async function chunkText(
  text: string,
  embedder: EmbeddingProvider,
  config: ChunkerConfig,
  metadata?: DocumentMetadata,
): Promise<TextChunk[]> {
  // AST chunking for TypeScript / JavaScript files
  if (
    metadata?.fileType === "code" &&
    metadata.language &&
    AST_LANGUAGES.has(metadata.language)
  ) {
    try {
      const chunks = await astChunkTypeScript(text, metadata.filePath, config.maxChunkSize);
      if (chunks.length > 0) {
        log.debug({ chunks: chunks.length, file: metadata.filePath }, "Used AST chunking");
        return chunks;
      }
    } catch (error) {
      log.warn({ err: error, file: metadata.filePath }, "AST chunking failed, falling back");
    }
  }

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
