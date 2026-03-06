import type { EmbeddingProvider } from "./provider.js";
import type { EmbeddingConfig } from "../config/schema.js";
import { TransformersEmbeddingProvider } from "./transformers.js";
import { OllamaEmbeddingProvider } from "./ollama.js";

export type { EmbeddingProvider } from "./provider.js";

/** Factory: create an embedding provider from config. */
export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider {
  switch (config.provider) {
    case "transformers":
      return new TransformersEmbeddingProvider(config.model, config.dimensions);
    case "ollama":
      return new OllamaEmbeddingProvider(config.model, config.dimensions, config.ollamaBaseUrl);
    default:
      throw new Error(`Unknown embedding provider: ${config.provider}`);
  }
}
