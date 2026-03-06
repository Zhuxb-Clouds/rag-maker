export interface EmbeddingProvider {
  /** Provider name for logging */
  readonly name: string;
  /** Vector dimensions */
  readonly dimensions: number;
  /** Embed a single text string */
  embed(text: string): Promise<number[]>;
  /** Embed a batch of text strings */
  embedBatch(texts: string[]): Promise<number[][]>;
}
