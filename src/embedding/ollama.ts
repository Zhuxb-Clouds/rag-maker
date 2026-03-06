import type { EmbeddingProvider } from "./provider.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("embedding:ollama");

/**
 * Embedding provider using Ollama's /api/embed endpoint.
 * Requires a running Ollama server.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = "ollama";
  readonly dimensions: number;

  private baseUrl: string;
  private model: string;

  constructor(model: string = "all-minilm", dimensions = 384, baseUrl = "http://localhost:11434") {
    this.model = model;
    this.dimensions = dimensions;
    this.baseUrl = baseUrl;
  }

  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    log.debug({ model: this.model, count: texts.length }, "Embedding batch");

    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama embedding failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as { embeddings: number[][] };
    return data.embeddings;
  }
}
