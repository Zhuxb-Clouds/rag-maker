# rag-maker

多源 RAG 系统：自动从 Git 仓库和本地目录索引文档到 LanceDB 向量数据库，并通过 MCP 服务器对外提供查询能力。

## 功能特性

- **多文档源**：支持 Git 仓库和本地目录，运行时动态增删
- **自动同步**：Cron 定时调度 + Git Webhook 触发，增量更新仅处理变更文件
- **语义分块**：基于 Embedding 相似度的智能文档切分，自动识别语义边界
- **本地 Embedding**：通过 Transformers.js 运行 `all-MiniLM-L6-v2`（ONNX 推理，无需 GPU）
- **LanceDB**：嵌入式向量数据库，无需外部服务，数据存储为本地目录
- **三重检索**：向量语义搜索、BM25 全文检索、混合检索三种模式
- **MCP 服务器**：暴露搜索、源管理、同步控制等工具，可直接对接 Claude Desktop / VS Code 等客户端

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置文档源

编辑 `config/sources.yaml`，添加你的文档源：

```yaml
sources:
  - id: my-docs
    name: 项目文档
    type: git
    url: https://github.com/user/docs.git
    branch: main
    cron: "0 * * * *"  # 每小时同步

  - id: local-notes
    name: 本地笔记
    type: local
    path: /home/user/notes
    cron: "*/30 * * * *"  # 每 30 分钟同步
```

### 3. 启动

```bash
# 开发模式（stdio 传输，用于 IDE 集成）
pnpm dev

# HTTP 模式（用于 Docker / 远程访问）
MCP_TRANSPORT=http pnpm dev
```

### 4. 接入 MCP 客户端

**Claude Desktop / VS Code（stdio 模式）**：

在 MCP 配置中添加：
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

**HTTP 模式**：通过 SSE 连接 `http://localhost:3000/sse`。

## MCP 工具列表

| 工具               | 说明                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------ |
| `search_documents` | 文档搜索，支持 `mode` 参数：`vector`（语义）/ `fulltext`（关键词）/ `hybrid`（混合） |
| `list_sources`     | 列出所有已配置的文档源及其同步状态                                                   |
| `add_source`       | 运行时动态添加 Git 或本地文档源                                                      |
| `remove_source`    | 删除文档源并清除其所有索引数据                                                       |
| `trigger_sync`     | 手动触发单个源或全部源的同步                                                         |
| `get_sync_status`  | 获取索引和同步状态的详细信息                                                         |

## 系统架构

```
┌──────────────┐    ┌──────────────┐    ┌───────────────┐
│  Git 仓库    │    │  本地目录    │    │ Git Webhooks  │
└──────┬───────┘    └──────┬───────┘    └───────┬───────┘
       │                   │                     │
       ▼                   ▼                     ▼
┌──────────────────────────────────────────────────────┐
│                     同步管线                          │
│  拉取 → 检测变更 → 解析 → 分块 → 向量化 → 入库       │
└──────────────────────┬───────────────────────────────┘
                       │
                       ▼
              ┌─────────────────┐
              │    LanceDB      │
              │   嵌入式数据库   │
              │  向量 + 全文索引 │
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │   MCP 服务器    │
              │  stdio / HTTP   │
              └─────────────────┘
```

## 同步管线流程

1. **拉取**：从 Git 仓库 pull 最新代码，或扫描本地目录
2. **检测变更**：Git 通过 `diff` 比较 commit 差异；本地目录通过内容哈希比较
3. **解析**：根据文件类型（Markdown / 代码 / PDF）提取文本内容
4. **分块**：使用 Embedding 计算相邻句子相似度，在语义断点处切分（长文档），短文档退化为固定大小分块
5. **向量化**：调用本地模型生成 Embedding 向量
6. **入库**：通过 merge-insert 写入 LanceDB，自动去重更新

## Docker 部署

```bash
# 构建并启动
docker compose up -d

# 健康检查
curl http://localhost:3000/health
```

## 配置参考

完整配置见 `config/sources.yaml`，主要参数：

| 配置项                                  | 默认值                    | 说明                                   |
| --------------------------------------- | ------------------------- | -------------------------------------- |
| `databasePath`                          | `./data/lancedb`          | LanceDB 存储目录                       |
| `reposPath`                             | `./data/repos`            | Git 仓库克隆目录                       |
| `embedding.provider`                    | `transformers`            | `transformers`（本地 ONNX）或 `ollama` |
| `embedding.model`                       | `Xenova/all-MiniLM-L6-v2` | 模型 ID                                |
| `embedding.dimensions`                  | `384`                     | 向量维度（需与模型匹配）               |
| `chunker.maxChunkSize`                  | `1000`                    | 最大分块字符数                         |
| `chunker.chunkOverlap`                  | `200`                     | 分块重叠字符数                         |
| `chunker.similarityThresholdPercentile` | `75`                      | 语义分块相似度阈值百分位               |
| `mcpTransport`                          | `stdio`                   | MCP 传输方式：`stdio` 或 `http`        |
| `server.port`                           | `3000`                    | HTTP 服务端口                          |

## 支持的文件类型

| 类型     | 扩展名                                                        |
| -------- | ------------------------------------------------------------- |
| Markdown | `.md`                                                         |
| 代码     | `.ts` `.js` `.py` `.go` `.java` `.rs` `.c` `.cpp` `.h` `.hpp` |
| PDF      | `.pdf`                                                        |
| 文本     | `.txt` `.json` `.yaml` `.yml`                                 |

## 技术栈

- **运行时**：Node.js ≥ 20，TypeScript（ESM）
- **向量数据库**：[LanceDB](https://lancedb.github.io/lancedb/)（嵌入式，基于 Apache Arrow）
- **Embedding**：[Transformers.js](https://huggingface.co/docs/transformers.js/)（ONNX/WASM）或 Ollama
- **MCP SDK**：[@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- **文档解析**：pdf-parse、自定义 Markdown/代码解析器
- **调度**：node-cron + Express webhook 端点

## 许可证

MIT
