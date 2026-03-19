import type { EmbeddingProvider } from "../embedding/provider.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("chunker:semantic");

/** A chunk of text with its position in the original document. */
export interface TextChunk {
  text: string;
  index: number;
}

/**
 * Split text into sentences using a simple heuristic.
 * Supports both whitespace-delimited and CJK punctuation-delimited sentence boundaries.
 */
function splitSentences(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) return [];

  // Split on sentence-ending punctuation.
  // For CJK text, punctuation is often followed by no whitespace.
  const sentences = normalized
    .split(/(?<=[.!?。！？])(?:\s+|(?=[A-Z0-9\u4e00-\u9fff"“'‘(\[]))/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // If no sentence boundaries found, split by paragraphs
  if (sentences.length <= 1) {
    return normalized
      .split(/\n\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  return sentences;
}

/** Compute cosine similarity between two vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Find the threshold value at a given percentile. */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * Semantic chunker: splits text at points where the embedding similarity
 * between consecutive sentences drops significantly.
 *
 * Algorithm:
 * 1. Split text into sentences
 * 2. Embed each sentence
 * 3. Compute cosine similarity between consecutive sentence embeddings
 * 4. Find similarity drops below threshold (percentile-based)
 * 5. Split at breakpoints, merge consecutive sentences into chunks
 */
export async function semanticChunk(
  text: string,
  embedder: EmbeddingProvider,
  options: {
    similarityThresholdPercentile?: number;
    maxChunkSize?: number;
    minChunkSentences?: number;
    overlapSentences?: number;
  } = {},
): Promise<TextChunk[]> {
  const {
    similarityThresholdPercentile: thresholdPercentile = 75,
    maxChunkSize = 1000,
    minChunkSentences = 2,
    overlapSentences = 1,
  } = options;
  const safeOverlap = Math.max(0, Math.floor(overlapSentences));

  const sentences = splitSentences(text);

  // Too few sentences — return as single chunk
  if (sentences.length <= minChunkSentences) {
    return [{ text: text.trim(), index: 0 }];
  }

  log.debug({ sentences: sentences.length }, "Embedding sentences for semantic chunking");

  // Embed all sentences
  const embeddings = await embedder.embedBatch(sentences);

  // Compute pairwise cosine similarity between consecutive sentences
  const similarities: number[] = [];
  for (let i = 0; i < embeddings.length - 1; i++) {
    similarities.push(cosineSimilarity(embeddings[i], embeddings[i + 1]));
  }

  // Determine similarity threshold: sentences with similarity drops below
  // this threshold are considered chunk boundaries
  // Lower percentile = more chunks, higher = fewer chunks
  const distances = similarities.map((s) => 1 - s);
  const threshold = percentile(distances, thresholdPercentile);

  // Find breakpoints (indices where we should split)
  const breakpoints: number[] = [];
  for (let i = 0; i < distances.length; i++) {
    if (distances[i] >= threshold) {
      breakpoints.push(i + 1); // split AFTER this sentence
    }
  }

  // Build chunk ranges from breakpoints
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  const splitPoints = [...breakpoints, sentences.length];

  for (const end of splitPoints) {
    if (end <= start) continue;
    ranges.push({ start, end });
    start = end;
  }

  // Build chunks from ranges with optional sentence overlap
  const chunks: TextChunk[] = [];
  let chunkIndex = 0;

  const appendSizedChunks = (rangeStart: number, rangeEnd: number) => {
    let subStart = rangeStart;

    while (subStart < rangeEnd) {
      let subEnd = subStart + 1;
      let subText = sentences[subStart] ?? "";

      while (subEnd < rangeEnd) {
        const candidate = `${subText} ${sentences[subEnd]}`;
        if (candidate.length > maxChunkSize) break;
        subText = candidate;
        subEnd++;
      }

      chunks.push({ text: subText.trim(), index: chunkIndex++ });

      if (subEnd >= rangeEnd) {
        break;
      }

      const nextStart = Math.max(subEnd - safeOverlap, subStart + 1);
      subStart = nextStart;
    }
  };

  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    const effectiveStart = i === 0 ? range.start : Math.max(0, range.start - safeOverlap);
    appendSizedChunks(effectiveStart, range.end);
  }

  log.debug(
    {
      sentences: sentences.length,
      chunks: chunks.length,
      breakpoints: breakpoints.length,
      overlapSentences: safeOverlap,
    },
    "Semantic chunking complete",
  );

  return chunks;
}
