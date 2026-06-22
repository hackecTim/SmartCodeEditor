#!/bin/bash
# SmartCode — zagonski skript
# Zahteva: Docker
# Zaženite iz mape smartCodev4/
#
# Uporaba:
#   ./smartcode.sh            -- zgradi in zaženi
#   ./smartcode.sh stop       -- ustavi
#   ./smartcode.sh logs       -- pokaži loge
#   ./smartcode.sh restart    -- ustavi in zaženi znova
#   ./smartcode.sh status     -- preveri status

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_DIR="$SCRIPT_DIR/langserver"
ENV_FILE="$COMPOSE_DIR/.env"

# Ustvari .env če ne obstaja
if [ ! -f "$ENV_FILE" ]; then
  cp "$COMPOSE_DIR/.env.example" "$ENV_FILE"
  echo "Ustvarjen $ENV_FILE — preveri poti pred zagonom!"
fi

case "$1" in
  stop)
    docker-compose -f "$COMPOSE_DIR/docker-compose.yml" --env-file "$ENV_FILE" down
    exit 0 ;;
  logs)
    docker-compose -f "$COMPOSE_DIR/docker-compose.yml" --env-file "$ENV_FILE" logs -f
    exit 0 ;;
  restart)
    docker-compose -f "$COMPOSE_DIR/docker-compose.yml" --env-file "$ENV_FILE" down
    docker-compose -f "$COMPOSE_DIR/docker-compose.yml" --env-file "$ENV_FILE" up -d --build
    exit 0 ;;
  status)
    docker-compose -f "$COMPOSE_DIR/docker-compose.yml" --env-file "$ENV_FILE" ps
    echo ""
    curl -s http://localhost:3000/health 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "LSP strežnik ne odgovarja"
    exit 0 ;;
esac

# Preberi poti iz .env za izpis
source "$ENV_FILE" 2>/dev/null || true

echo "=== SmartCode ==="
echo "  algator_projects: ${ALGATOR_PROJECTS}"
echo "  algator_lsync_root:    ${ALGATOR_LSYNC}"
echo "  LSP:              http://localhost:3000"
echo ""
echo "  Za spremembo poti uredi: langserver/.env"
echo ""

docker-compose -f "$COMPOSE_DIR/docker-compose.yml" --env-file "$ENV_FILE" up -d --build || exit 1

echo ""
echo "OK. Odpri urejevalnik:"
echo "  editor-single.html?projectFolder=PROJ-BasicSort"
echo ""
echo "  ./smartcode.sh logs     — logi"
echo "  ./smartcode.sh stop     — ustavi"
echo "  ./smartcode.sh status   — status"
