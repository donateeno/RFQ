#!/usr/bin/env bash
# Step 1 — read-only check of the VPS. Changes nothing. Paste the whole output back to Claude.
echo "== system";  . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME | $(nproc) CPU | $(free -h | awk '/Mem:/{print $2}') RAM | disk free $(df -h / | awk 'NR==2{print $4}') | TZ $(cat /etc/timezone 2>/dev/null || date +%Z)"
echo "== docker";  docker --version 2>/dev/null || echo "docker: NOT INSTALLED"; docker compose version 2>/dev/null || echo "compose: NOT INSTALLED"
echo "== containers"; docker ps --format '{{.Names}} | {{.Image}} | {{.Ports}}' 2>/dev/null
echo "== ports 80/443"; (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E ':(80|443|3000|5432) ' || echo "nothing on 80/443/3000/5432"
T=$(docker ps -qf name=traefik 2>/dev/null | head -1)
if [ -n "$T" ]; then
  echo "== traefik"
  echo "networks: $(docker inspect "$T" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
  docker inspect "$T" --format '{{range .Args}}{{println .}}{{end}}' | grep -E 'entrypoints\.|certificatesresolvers\.[^.]+\.' | sed -E 's/=.*//' | sort -u
fi
N=$(docker ps -qf name=n8n 2>/dev/null | head -1)
[ -n "$N" ] && { echo "== n8n"; docker inspect "$N" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^(N8N_HOST|WEBHOOK_URL|GENERIC_TIMEZONE)=' ; }
echo "== firewall"; (ufw status 2>/dev/null | head -5) || echo "ufw not used (check hPanel firewall)"
echo "== tools"; for c in git curl claude openclaw; do printf '%s: ' "$c"; command -v "$c" >/dev/null && echo yes || echo no; done
id deploy >/dev/null 2>&1 && echo "user deploy: exists" || echo "user deploy: not yet"
echo "== public IP: $(curl -s -4 --max-time 5 ifconfig.me || echo unknown)"
