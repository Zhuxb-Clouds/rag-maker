/** Metadata attached to a parsed document. */
export interface DocumentMetadata {
  /** Source ID this document belongs to */
  sourceId: string;
  /** Relative file path within the source */
  filePath: string;
  /** File type category */
  fileType: "markdown" | "code" | "pdf" | "text";
  /** Programming language (for code files) */
  language?: string;
  /** Title extracted from the document (if any) */
  title?: string;
}

/** A document that has been read and parsed into text. */
export interface ParsedDocument {
  /** Content hash for change detection */
  contentHash: string;
  /** Extracted text content */
  content: string;
  /** Document metadata */
  metadata: DocumentMetadata;
}
