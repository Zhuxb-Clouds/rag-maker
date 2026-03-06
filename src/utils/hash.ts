import { createHash } from "node:crypto";

/** Generate a deterministic content hash for deduplication / change detection. */
export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Generate a unique chunk ID from source, file path, and chunk index. */
export function chunkId(sourceId: string, filePath: string, chunkIndex: number): string {
  const raw = `${sourceId}::${filePath}::${chunkIndex}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}
