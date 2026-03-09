FROM node:20-slim

# git is required at runtime by simple-git (clone / pull sources)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package metadata
COPY package.json ./

# Copy pre-built artifacts from local (build with: pnpm install && pnpm build)
COPY node_modules/ ./node_modules/
COPY dist/ ./dist/

# Pre-bundle embedding models so the image works fully offline
COPY data/models/ ./data/models/

# Create runtime data directories
RUN mkdir -p data/lancedb data/repos

EXPOSE 10086

ENV NODE_ENV=production
ENV MCP_TRANSPORT=http

CMD ["node", "dist/index.js"]
