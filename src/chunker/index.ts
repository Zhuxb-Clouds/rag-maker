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

/** Split markdown into heading-based sections while preserving heading lines. */
function splitMarkdownSections(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const sections: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const section = current.join("\n").trim();
    if (section.length > 0) {
      sections.push(section);
    }
    current = [];
  };

  for (const line of lines) {
    if (/^#{1,6}\s+\S/.test(line) && current.length > 0) {
      flush();
    }
    current.push(line);
  }

  flush();

  if (sections.length === 0 && text.trim().length > 0) {
    sections.push(text.trim());
  }

  return sections;
}

/**
 * Chunk text with configurable strategy.
 *
 * Strategy:
 * 0. TypeScript / JavaScript code → AST-based structural chunking
 * 1. Very short text → single chunk
 * 2. Markdown → heading-based sections; long sections use semantic chunking
 * 3. Text >= SEMANTIC_MIN_LENGTH and semantic enabled → semantic chunking (embedding-based)
 * 4. Otherwise → RecursiveCharacterTextSplitter (fast, no embedding needed for splitting)
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

  // Markdown: split by heading first, then semantic-chunk only long sections.
  // This keeps section boundaries stable and avoids embedding every short section.
  if (metadata?.fileType === "markdown") {
    try {
      const sections = splitMarkdownSections(text);
      const chunks: TextChunk[] = [];

      for (const section of sections) {
        const sectionText = section.trim();
        if (sectionText.length === 0) continue;

        const sectionChunks =
          sectionText.length >= config.markdownSemanticSectionMinLength
            ? await semanticChunk(sectionText, embedder, {
              similarityThresholdPercentile: config.similarityThresholdPercentile,
              maxChunkSize: config.maxChunkSize,
              minChunkSentences: config.minChunkSentences,
              overlapSentences: config.semanticOverlapSentences,
            })
            : await fallbackChunk(sectionText, {
              maxChunkSize: config.maxChunkSize,
              chunkOverlap: config.chunkOverlap,
            });

        for (const c of sectionChunks) {
          const chunkText = c.text.trim();
          if (chunkText.length > 0) {
            chunks.push({ text: chunkText, index: chunks.length });
          }
        }
      }

      if (chunks.length > 0) {
        log.debug({ chunks: chunks.length, sections: sections.length }, "Used markdown section chunking");
        return chunks;
      }
    } catch (error) {
      log.warn({ err: error, file: metadata.filePath }, "Markdown section chunking failed, falling back");
    }
  }

  // Semantic chunking only for very long texts (expensive: embeds every sentence)
  if (text.length >= SEMANTIC_MIN_LENGTH) {
    try {
      const chunks = await semanticChunk(text, embedder, {
        similarityThresholdPercentile: config.similarityThresholdPercentile,
        maxChunkSize: config.maxChunkSize,
        minChunkSentences: config.minChunkSentences,
        overlapSentences: config.semanticOverlapSentences,
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
