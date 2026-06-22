FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    lsyncd \
    rsync \
    findutils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY start-lsync.sh /app/start-lsync.sh
COPY lsyncd.conf.lua /etc/lsyncd.conf.lua

RUN chmod +x /app/start-lsync.sh \
    && mkdir -p /algator_projects /algator_lsync_root /var/log/lsyncd

VOLUME ["/algator_projects", "/algator_lsync_root"]

CMD ["/app/start-lsync.sh"]
