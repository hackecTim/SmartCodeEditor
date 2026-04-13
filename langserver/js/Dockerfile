FROM node:20-bookworm

# ── System deps + clangd ──────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    clangd \
    clang \
    cmake \
    build-essential \
    wget \
    default-jdk \
    && rm -rf /var/lib/apt/lists/*

# ── jdtls ─────────────────────────────────────────────────────────────
RUN mkdir -p /opt/jdtls && \
    wget -q https://download.eclipse.org/jdtls/milestones/1.9.0/jdt-language-server-1.9.0-202203031534.tar.gz \
         -O /tmp/jdtls.tar.gz && \
    tar -xzf /tmp/jdtls.tar.gz -C /opt/jdtls && \
    rm /tmp/jdtls.tar.gz

# ── Node app ──────────────────────────────────────────────────────────
WORKDIR /app
RUN mkdir -p /workspace /workspace/java-data

COPY package.json ./
RUN npm install

COPY server.js ./
COPY start.sh ./
RUN chmod +x /app/start.sh

EXPOSE 3000
CMD ["/app/start.sh"]
