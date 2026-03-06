import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { TextChunk } from "./semantic-chunker.js";

/**
 * Fallback chunker using RecursiveCharacterTextSplitter.
 * Used when semantic chunking fails or for very short documents.
 */
export async function fallbackChunk(
  text: string,
  options: {
    maxChunkSize?: number;
    chunkOverlap?: number;
  } = {},
): Promise<TextChunk[]> {
  const { maxChunkSize = 1000, chunkOverlap = 200 } = options;

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: maxChunkSize,
    chunkOverlap,
    separators: ["\n\n", "\n", ". ", " ", ""],
  });

  const chunks = await splitter.splitText(text);

  return chunks.map((text, index) => ({
    text: text.trim(),
    index,
  }));
}
