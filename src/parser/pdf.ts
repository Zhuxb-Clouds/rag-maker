import { readFile } from "node:fs/promises";
import type { ParsedDocument, DocumentMetadata } from "./types.js";
import { contentHash } from "../utils/hash.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("parser:pdf");

/** Parse a PDF file and extract text content. */
export async function parsePdf(
  filePath: string,
  metadata: Omit<DocumentMetadata, "fileType">,
): Promise<ParsedDocument> {
  const { PDFParse } = await import("pdf-parse");
  const buffer = await readFile(filePath);
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  parser.destroy();
  const text = result.text;

  if (!text || text.trim().length === 0) {
    log.warn({ filePath }, "PDF contains no extractable text (scanned?)");
  }

  return {
    contentHash: contentHash(text),
    content: text,
    metadata: {
      ...metadata,
      fileType: "pdf",
    },
  };
}
