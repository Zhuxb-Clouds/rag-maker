import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { ParsedDocument, DocumentMetadata } from "./types.js";
import { parseMarkdown } from "./markdown.js";
import { parseCode, detectLanguage } from "./code.js";
import { parsePdf } from "./pdf.js";
import { contentHash } from "../utils/hash.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("parser:router");

export type { ParsedDocument, DocumentMetadata } from "./types.js";

const MARKDOWN_EXTS = new Set([".md", ".mdx", ".markdown"]);
const CODE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".r",
  ".lua",
  ".zig",
]);
const PDF_EXTS = new Set([".pdf"]);
const TEXT_EXTS = new Set([
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".csv",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".env.example",
]);

/**
 * Parse a file into a ParsedDocument based on its extension.
 * Returns null for unsupported file types.
 */
export async function parseFile(
  absolutePath: string,
  metadata: Omit<DocumentMetadata, "fileType">,
): Promise<ParsedDocument | null> {
  const ext = extname(absolutePath).toLowerCase();

  try {
    if (PDF_EXTS.has(ext)) {
      return await parsePdf(absolutePath, metadata);
    }

    // All other types are read as text
    const content = await readFile(absolutePath, "utf-8");

    if (MARKDOWN_EXTS.has(ext)) {
      return parseMarkdown(content, metadata);
    }

    if (CODE_EXTS.has(ext)) {
      return parseCode(content, metadata);
    }

    if (TEXT_EXTS.has(ext)) {
      return {
        contentHash: contentHash(content),
        content,
        metadata: { ...metadata, fileType: "text" },
      };
    }

    // Try to detect code by language mapping
    if (detectLanguage(absolutePath)) {
      return parseCode(content, metadata);
    }

    log.debug({ ext, path: absolutePath }, "Unsupported file type, treating as plain text");
    return {
      contentHash: contentHash(content),
      content,
      metadata: { ...metadata, fileType: "text" },
    };
  } catch (error) {
    log.error({ error, path: absolutePath }, "Failed to parse file");
    return null;
  }
}
