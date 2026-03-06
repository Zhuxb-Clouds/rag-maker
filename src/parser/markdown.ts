import type { ParsedDocument, DocumentMetadata } from "./types.js";
import { contentHash } from "../utils/hash.js";

/** Extract title from Markdown (first # heading). */
function extractTitle(content: string): string | undefined {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim();
}

/** Parse a Markdown file. */
export function parseMarkdown(
  content: string,
  metadata: Omit<DocumentMetadata, "fileType">,
): ParsedDocument {
  return {
    contentHash: contentHash(content),
    content,
    metadata: {
      ...metadata,
      fileType: "markdown",
      title: extractTitle(content),
    },
  };
}
