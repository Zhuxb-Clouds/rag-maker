# rag-maker

Multi-source RAG system that indexes documents from Git repos and local directories into a LanceDB vector store, with MCP server for external querying.

## Features

- **Multi-source**: Git repositories and local directories
- **Auto-sync**: Cron schedules + Git webhook triggers, with incremental updates
- **Semantic chunking**: Embedding-based intelligent document splitting
- **Local embeddings**: Runs `all-MiniLM-L6-v2` via Transformers.js (ONNX, no GPU needed)
- **LanceDB**: Embedded vector database — no external server required
- **Triple search**: Vector (semantic), full-text (BM25), and hybrid modes
- **MCP Server**: Exposes tools for search, source management, and sync control

## Quick Start

### 1. Install

```bash
npm install
```

### 2. Configure

Edit `config/sources.yaml` to add your document sources:

```yaml
sources:
  - id: my-docs
    name: My Documentation
    type: git
    url: https://github.com/user/docs.git
    branch: main
    cron: "0 * * * *"

  - id: local-notes
    name: Local Notes
    type: local
    path: /home/user/notes
    cron: "*/30 * * * *"
```

### 3. Run

```bash
# Development (stdio mode — for IDE integration)
npm run dev

# Or with HTTP mode (for Docker / remote access)
MCP_TRANSPORT=http npm run dev
```

### 4. Connect to MCP

**Claude Desktop / VS Code (stdio)**:

Add to your MCP settings:
```json
{
  "mcpServers": {
    "rag-maker": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "cwd": "/path/to/rag-maker"
    }
  }
}
```

**HTTP mode** — connect via SSE at `http://localhost:3000/sse`.

## MCP Tools

| Tool               | Description                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `search_documents` | Search by semantic query, keywords, or hybrid. Supports `mode`: vector / fulltext / hybrid |
| `list_sources`     | List all configured document sources and their sync status                                 |
| `add_source`       | Add a new Git or local document source at runtime                                          |
| `remove_source`    | Remove a source and delete all its indexed data                                            |
| `trigger_sync`     | Manually trigger sync for one source or all                                                |
| `get_sync_status`  | Get detailed status of indexes and sync state                                              |

## Architecture

```
┌──────────────┐    ┌──────────────┐    ┌───────────────┐
│  Git Repos   │    │ Local Dirs   │    │ Git Webhooks  │
└──────┬───────┘    └──────┬───────┘    └───────┬───────┘
       │                   │                     │
       ▼                   ▼                     ▼
┌──────────────────────────────────────────────────────┐
│                   Sync Pipeline                       │
│  pull → detect changes → parse → chunk → embed → store│
└──────────────────────┬───────────────────────────────┘
                       │
                       ▼
              ┌─────────────────┐
              │    LanceDB      │
              │  (embedded DB)  │
              │  Vector + FTS   │
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │   MCP Server    │
              │  stdio / HTTP   │
              └─────────────────┘
```

## Docker

```bash
# Build and run
docker compose up -d

# Check health
curl http://localhost:3000/health
```

## Configuration Reference

See `config/sources.yaml` for all options. Key settings:

| Setting                | Default                   | Description                             |
| ---------------------- | ------------------------- | --------------------------------------- |
| `databasePath`         | `./data/lancedb`          | LanceDB storage directory               |
| `embedding.provider`   | `transformers`            | `transformers` (local ONNX) or `ollama` |
| `embedding.model`      | `Xenova/all-MiniLM-L6-v2` | Model ID                                |
| `embedding.dimensions` | `384`                     | Vector dimensions                       |
| `chunker.maxChunkSize` | `1000`                    | Max chunk size in characters            |
| `mcpTransport`         | `stdio`                   | `stdio` or `http`                       |

## License

MIT
