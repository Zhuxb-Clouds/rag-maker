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
 * Handles common sentence boundaries including abbreviations.
 */
function splitSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by whitespace
  const sentences = text
    .split(/(?<=[.!?。！？])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // If no sentence boundaries found, split by paragraphs
  if (sentences.length <= 1) {
    return text
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
  } = {},
): Promise<TextChunk[]> {
  const {
    similarityThresholdPercentile: thresholdPercentile = 75,
    maxChunkSize = 1000,
    minChunkSentences = 2,
  } = options;

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

  // Build chunks from breakpoints
  const chunks: TextChunk[] = [];
  let start = 0;
  let chunkIndex = 0;

  const splitPoints = [...breakpoints, sentences.length];

  for (const end of splitPoints) {
    if (end <= start) continue;

    let chunkText = sentences.slice(start, end).join(" ");

    // If chunk exceeds maxChunkSize, split it further
    if (chunkText.length > maxChunkSize) {
      // Sub-split the oversized chunk
      let subStart = start;
      while (subStart < end) {
        let subEnd = subStart + 1;
        let subText = sentences[subStart];

        while (subEnd < end) {
          const candidate = subText + " " + sentences[subEnd];
          if (candidate.length > maxChunkSize) break;
          subText = candidate;
          subEnd++;
        }

        chunks.push({ text: subText.trim(), index: chunkIndex++ });
        subStart = subEnd;
      }
    } else {
      chunks.push({ text: chunkText.trim(), index: chunkIndex++ });
    }

    start = end;
  }

  log.debug(
    { sentences: sentences.length, chunks: chunks.length, breakpoints: breakpoints.length },
    "Semantic chunking complete",
  );

  return chunks;
}
