#!/usr/bin/env bash
# Runs on the VPS (by GitHub Actions over SSH, or by hand): update to origin/main and restart.
set -euo pipefail
cd "$(dirname "$0")/.."
git fetch --quiet origin main
git reset --hard origin/main
cd deploy
[ -f .env ] || { echo "deploy/.env missing — copy .env.example and fill it in"; exit 1; }
PROXY=$(grep -E '^PROXY=' .env | cut -d= -f2 || true)
FILES=(-f docker-compose.yml)
[ -n "${PROXY:-}" ] && FILES+=(-f "docker-compose.${PROXY}.yml")
docker compose "${FILES[@]}" up -d --build --remove-orphans
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$(grep -E '^APP_PORT=' .env | cut -d= -f2 || echo 3000)/healthz" >/dev/null 2>&1; then
    echo "RFQ deployed: $(git rev-parse --short HEAD)"; docker image prune -f >/dev/null; exit 0
  fi
  sleep 2
done
echo "Health check failed"; docker compose "${FILES[@]}" logs --tail=80 app; exit 1
