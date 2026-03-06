import type { ParsedDocument, DocumentMetadata } from "./types.js";
import { contentHash } from "../utils/hash.js";
import { extname } from "node:path";

const LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".scala": "scala",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".sql": "sql",
  ".r": "r",
  ".lua": "lua",
  ".zig": "zig",
};

/** Detect programming language from file extension. */
export function detectLanguage(filePath: string): string | undefined {
  const ext = extname(filePath).toLowerCase();
  return LANGUAGE_MAP[ext];
}

/** Parse a code file — wraps the raw content with language metadata. */
export function parseCode(
  content: string,
  metadata: Omit<DocumentMetadata, "fileType">,
): ParsedDocument {
  const language = detectLanguage(metadata.filePath);
  return {
    contentHash: contentHash(content),
    content,
    metadata: {
      ...metadata,
      fileType: "code",
      language,
    },
  };
}
