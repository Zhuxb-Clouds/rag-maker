import { z } from "zod";

// ─── Document source config ───

/** Common fields shared by all source types */
const BaseSourceFields = {
  /** Unique identifier for this source */
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string(),
  /** Glob patterns for files to include (default: all supported types) */
  include: z
    .array(z.string())
    .default([
      "**/*.md",
      "**/*.txt",
      "**/*.pdf",
      "**/*.ts",
      "**/*.js",
      "**/*.py",
      "**/*.go",
      "**/*.java",
      "**/*.rs",
      "**/*.c",
      "**/*.cpp",
      "**/*.h",
      "**/*.hpp",
      "**/*.json",
      "**/*.yaml",
      "**/*.yml",
    ]),
  /** Glob patterns for files to exclude */
  exclude: z
    .array(z.string())
    .default(["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**"]),
  /** Cron expression for scheduled sync (default: every hour) */
  cron: z.string().default("0 * * * *"),
  /** Webhook secret for push-triggered sync */
  webhookSecret: z.string().optional(),
  /** Whether this source is enabled */
  enabled: z.boolean().default(true),
};

const GitSourceSchema = z.object({
  ...BaseSourceFields,
  type: z.literal("git"),
  url: z.string().url(),
  branch: z.string().default("main"),
  /** Optional personal access token or deploy key path */
  auth: z
    .object({
      token: z.string().optional(),
      sshKeyPath: z.string().optional(),
    })
    .optional(),
  /** Shallow clone depth (default 1) */
  depth: z.number().int().positive().default(1),
});

const LocalSourceSchema = z.object({
  ...BaseSourceFields,
  type: z.literal("local"),
  path: z.string(),
});

const DocumentSourceSchema = z.discriminatedUnion("type", [GitSourceSchema, LocalSourceSchema]);

export type DocumentSourceConfig = z.infer<typeof DocumentSourceSchema>;

// ─── Embedding config ───

const EmbeddingConfigSchema = z.object({
  provider: z.enum(["transformers", "ollama"]).default("transformers"),
  /** Model name / ID */
  model: z.string().default("Xenova/all-MiniLM-L6-v2"),
  /** Vector dimensions (must match the model) */
  dimensions: z.number().int().positive().default(384),
  /** Ollama base URL (only for ollama provider) */
  ollamaBaseUrl: z.string().url().default("http://localhost:11434"),
});

export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;

// ─── Chunker config ───

const ChunkerConfigSchema = z.object({
  /** Max chunk size in characters */
  maxChunkSize: z.number().int().positive().default(1000),
  /** Chunk overlap in characters (for fallback splitter) */
  chunkOverlap: z.number().int().nonnegative().default(200),
  /** Similarity threshold percentile for semantic chunking (0-100) */
  similarityThresholdPercentile: z.number().min(0).max(100).default(75),
  /** Minimum sentences per chunk */
  minChunkSentences: z.number().int().positive().default(2),
  /** Sentence overlap between semantic chunks */
  semanticOverlapSentences: z.number().int().nonnegative().default(1),
  /** Minimum markdown section length (chars) to use semantic chunking */
  markdownSemanticSectionMinLength: z.number().int().positive().default(1200),
});

export type ChunkerConfig = z.infer<typeof ChunkerConfigSchema>;

// ─── Top-level config ───

export const AppConfigSchema = z.object({
  /** LanceDB database directory path */
  databasePath: z.string().default("./data/lancedb"),
  /** Directory to clone git repos into */
  reposPath: z.string().default("./data/repos"),
  /** Path to persist source state */
  statePath: z.string().default("./data/sources-state.json"),
  /** Embedding configuration */
  embedding: EmbeddingConfigSchema.default({
    provider: "transformers",
    model: "Xenova/all-MiniLM-L6-v2",
    dimensions: 384,
    ollamaBaseUrl: "http://localhost:11434",
  }),
  /** Chunker configuration */
  chunker: ChunkerConfigSchema.default({
    maxChunkSize: 1000,
    chunkOverlap: 200,
    similarityThresholdPercentile: 75,
    minChunkSentences: 2,
    semanticOverlapSentences: 1,
    markdownSemanticSectionMinLength: 1200,
  }),
  /** Document sources */
  sources: z.array(DocumentSourceSchema).default([]),
  /** Server configuration */
  server: z
    .object({
      port: z.number().int().positive().default(3000),
      host: z.string().default("0.0.0.0"),
    })
    .default({ port: 3000, host: "0.0.0.0" }),
  /** MCP transport mode */
  mcpTransport: z.enum(["stdio", "http"]).default("stdio"),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
