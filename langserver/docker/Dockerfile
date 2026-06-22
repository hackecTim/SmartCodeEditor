FROM node:20-bookworm

# ── Temurin 21 ────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y wget apt-transport-https gnupg && \
    wget -qO- https://packages.adoptium.net/artifactory/api/gpg/key/public \
       | gpg --dearmor -o /usr/share/keyrings/adoptium.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb bookworm main" \
       > /etc/apt/sources.list.d/adoptium.list && \
    apt-get update && apt-get install -y temurin-21-jdk && \
    rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/temurin-21-amd64
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# ── Build tools + clangd ──────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    clangd \
    clang \
    cmake \
    build-essential \
    rsync \
    && rm -rf /var/lib/apt/lists/*

# ── jdtls ─────────────────────────────────────────────────────────────
ARG JDTLS_VERSION=1.9.0
ARG JDTLS_DATE=202203031534
RUN mkdir -p /opt/jdtls && \
    wget -q "https://download.eclipse.org/jdtls/milestones/${JDTLS_VERSION}/jdt-language-server-${JDTLS_VERSION}-${JDTLS_DATE}.tar.gz" \
         -O /tmp/jdtls.tar.gz && \
    tar -xzf /tmp/jdtls.tar.gz -C /opt/jdtls && \
    rm /tmp/jdtls.tar.gz

# ── App ───────────────────────────────────────────────────────────────
WORKDIR /app
RUN mkdir -p /algator_lsync_root /workspace /tmp/jdtls-data

COPY js/package.json js/package-lock.json ./
RUN npm ci --omit=dev

COPY js/server.js ./
COPY docker/start.sh ./
RUN chmod +x /app/start.sh

# LSP Docker nima dostopa do <algator_projects>.
# /algator_lsync_root = LSP/code completion root, ki ga polni lsync.
# /workspace = delovna mapa PROJECT načina, kamor editor shranjuje spremembe.
VOLUME ["/algator_lsync_root", "/workspace"]

EXPOSE 3000
CMD ["/app/start.sh"]
