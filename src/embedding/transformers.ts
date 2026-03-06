import type { EmbeddingProvider } from "./provider.js";
import { createChildLogger } from "../utils/logger.js";

const log = createChildLogger("embedding:transformers");

/**
 * Embedding provider using @huggingface/transformers (ONNX Runtime in Node.js).
 * Loads the model lazily on first call.
 */
export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly name = "transformers";
  readonly dimensions: number;

  private pipeline: any = null;
  private modelId: string;

  constructor(modelId: string = "Xenova/all-MiniLM-L6-v2", dimensions = 384) {
    this.modelId = modelId;
    this.dimensions = dimensions;
  }

  private async getPipeline() {
    if (!this.pipeline) {
      log.info({ model: this.modelId }, "Loading embedding model...");

      // Setup proxy for model download if configured via env
      const proxyUrl =
        process.env.https_proxy ||
        process.env.HTTPS_PROXY ||
        process.env.http_proxy ||
        process.env.HTTP_PROXY;
      if (proxyUrl) {
        try {
          const { ProxyAgent, setGlobalDispatcher } = await import("undici");
          setGlobalDispatcher(new ProxyAgent(proxyUrl));
          log.info({ proxy: proxyUrl }, "Proxy configured for model download");
        } catch {
          log.warn("undici not available, proxy env vars may not work with native fetch");
        }
      }

      // Dynamic import to avoid loading the heavy module at startup
      const { pipeline, env } = await import("@huggingface/transformers");
      // Cache models in ./data/models
      env.cacheDir = "./data/models";
      this.pipeline = await pipeline("feature-extraction", this.modelId, {
        dtype: "q8",
      });
      log.info({ model: this.modelId }, "Embedding model loaded");
    }
    return this.pipeline;
  }

  async embed(text: string): Promise<number[]> {
    const pipe = await this.getPipeline();
    const output = await pipe(text, { pooling: "mean", normalize: true });
    return Array.from(output.data as Float32Array).slice(0, this.dimensions);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const pipe = await this.getPipeline();
    const results: number[][] = [];
    // Process in smaller batches to balance throughput and memory
    const batchSize = 64;
    const totalBatches = Math.ceil(texts.length / batchSize);
    for (let i = 0; i < texts.length; i += batchSize) {
      const batchNum = Math.floor(i / batchSize) + 1;
      const batch = texts.slice(i, i + batchSize);

      if (totalBatches > 1 && (batchNum === 1 || batchNum % 5 === 0 || batchNum === totalBatches)) {
        log.info(
          { batch: `${batchNum}/${totalBatches}`, embedded: results.length, total: texts.length },
          `Embedding batch ${batchNum}/${totalBatches}`,
        );
      }

      // Pass the entire batch as an array — Transformers.js handles batched inference
      const output = await pipe(batch, { pooling: "mean", normalize: true });
      // output.tolist() returns number[][] for batched input
      if (batch.length === 1) {
        results.push(Array.from(output.data as Float32Array).slice(0, this.dimensions));
      } else {
        const flat = Array.from(output.data as Float32Array);
        for (let j = 0; j < batch.length; j++) {
          results.push(flat.slice(j * this.dimensions, (j + 1) * this.dimensions));
        }
      }
    }
    return results;
  }
}
