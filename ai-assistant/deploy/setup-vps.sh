#!/usr/bin/env bash
# NextaStore assistant - one-shot setup for a fresh Ubuntu 22.04 / 24.04 VPS (4 GB or 8 GB RAM, CPU only).
#
#   sudo bash deploy/setup-vps.sh [--skip-models] [--firewall]
#
#   --skip-models  do not download models now (you will run the ollama pull lines yourself)
#   --firewall     also turn on ufw: allow SSH, 80, 443, deny everything else
#                  (off by default so a non-standard SSH port can not lock you out)
#
# Safe to run again: every step checks first. It never touches your database or backend.
# Environment overrides: APP_DIR (default /opt/nextastore-ai), SWAP_GB (default chosen by RAM profile).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/nextastore-ai}"
TOTAL_RAM_MB="$(free -m | awk '/^Mem:/{print $2}')"
if [ "${TOTAL_RAM_MB:-0}" -lt 6000 ]; then PROFILE="4gb"; DEFAULT_SWAP_GB=2; else PROFILE="8gb"; DEFAULT_SWAP_GB=4; fi
SWAP_GB="${SWAP_GB:-$DEFAULT_SWAP_GB}"
echo "Selected Nexi profile: ${PROFILE} (${TOTAL_RAM_MB} MB RAM); swap target: ${SWAP_GB} GB"
SKIP_MODELS=0
FIREWALL=0
for arg in "$@"; do
  case "$arg" in
    --skip-models) SKIP_MODELS=1 ;;
    --firewall) FIREWALL=1 ;;
    *) echo "Unknown option: $arg"; exit 2 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo bash deploy/setup-vps.sh"; exit 1; }
. /etc/os-release
case "${ID:-}" in ubuntu|debian) ;; *) echo "This script targets Ubuntu/Debian (found: ${ID:-unknown})."; exit 1 ;; esac

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DEBIAN_FRONTEND=noninteractive

say "1/9 Base packages"
apt-get update -y
apt-get install -y curl ca-certificates rsync openssl

say "2/9 Swap (${SWAP_GB} GB safety net, not a substitute for RAM)"
if swapon --show --noheadings | grep -q .; then
  echo "Swap already present, leaving it alone."
else
  fallocate -l "${SWAP_GB}G" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
# Prefer RAM; only swap when really needed.
echo 'vm.swappiness=10' > /etc/sysctl.d/99-nexi.conf
sysctl -p /etc/sysctl.d/99-nexi.conf >/dev/null

say "3/9 Node.js (22 LTS)"
NODE_MAJOR="$(node -v 2>/dev/null | sed 's/^v//;s/\..*//' || true)"
if [ -z "${NODE_MAJOR}" ] || [ "${NODE_MAJOR}" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

say "4/9 Ollama"
if ! command -v ollama >/dev/null 2>&1; then
  curl -fsSL https://ollama.com/install.sh | sh
fi
mkdir -p /etc/systemd/system/ollama.service.d
install -m 644 "$SRC_DIR/deploy/ollama-override.conf" /etc/systemd/system/ollama.service.d/override.conf
systemctl daemon-reload
systemctl enable ollama >/dev/null 2>&1 || true
systemctl restart ollama
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS http://127.0.0.1:11434/api/tags >/dev/null || { echo "Ollama did not start. Check: journalctl -u ollama -n 50"; exit 1; }

say "5/9 Service user and app files in $APP_DIR"
id -u nexi >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin nexi
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude node_modules --exclude .env --exclude data --exclude 'src/rag/index.json' \
  "$SRC_DIR/" "$APP_DIR/"
mkdir -p "$APP_DIR/data"

say "6/9 Settings (.env)"
if [ ! -f "$APP_DIR/.env" ]; then
  if [ "$PROFILE" = "4gb" ]; then cp "$APP_DIR/.env.vps-4gb.example" "$APP_DIR/.env"; else cp "$APP_DIR/.env.vps.example" "$APP_DIR/.env"; fi
  TOKEN="$(openssl rand -hex 24)"
  sed -i "s/^ASSISTANT_TOKEN=.*/ASSISTANT_TOKEN=${TOKEN}/" "$APP_DIR/.env"
  echo "Created $APP_DIR/.env with a new ASSISTANT_TOKEN."
  echo "Put this SAME value in nextastore-backend/.env as ASSISTANT_TOKEN:"
  echo "    ASSISTANT_TOKEN=${TOKEN}"
  echo "Also edit CORS_ORIGIN in $APP_DIR/.env to your real site address."
else
  echo "$APP_DIR/.env already exists, keeping it."
fi
chown -R nexi:nexi "$APP_DIR"
chmod 640 "$APP_DIR/.env"

say "7/9 Dependencies"
sudo -u nexi bash -c "cd '$APP_DIR' && npm install --omit=dev --no-audit --no-fund"

env_value() { grep -E "^$1=" "$APP_DIR/.env" | tail -n1 | cut -d= -f2- | tr -d '\r' ; }

say "8/9 Models (this downloads a few GB the first time)"
if [ "$SKIP_MODELS" -eq 1 ]; then
  echo "Skipped. Later, run:"
  for key in CHAT_MODEL GANDA_MODEL; do
    m="$(env_value $key || true)"; [ -n "$m" ] && echo "    ollama pull $m"
  done
  if [ "$(env_value RETRIEVAL || true)" = "hybrid" ]; then echo "    ollama pull $(env_value EMBED_MODEL || echo bge-m3)"; fi
else
  for key in CHAT_MODEL GANDA_MODEL; do
    m="$(env_value $key || true)"
    [ -n "$m" ] && ollama pull "$m"
  done
  # Only the optional hybrid retrieval mode needs an embedding model and an index.
  if [ "$(env_value RETRIEVAL || true)" = "hybrid" ]; then
    ollama pull "$(env_value EMBED_MODEL || echo bge-m3)"
    say "Building the embedding index (RETRIEVAL=hybrid)"
    sudo -u nexi bash -c "cd '$APP_DIR' && npm run reindex"
  fi
fi

say "9/9 Start the assistant"
SERVICE_MEMORY="900M"; [ "$PROFILE" = "4gb" ] && SERVICE_MEMORY="400M"
sed -e "s#@APP_DIR@#${APP_DIR}#g" -e "s#MemoryMax=400M#MemoryMax=${SERVICE_MEMORY}#g" "$APP_DIR/deploy/nextastore-ai.service" > /etc/systemd/system/nextastore-ai.service
 echo "Installed Nexi Node MemoryMax=${SERVICE_MEMORY} for ${PROFILE} profile."
systemctl daemon-reload
systemctl enable nextastore-ai >/dev/null 2>&1
systemctl restart nextastore-ai

if [ "$FIREWALL" -eq 1 ]; then
  say "Firewall"
  apt-get install -y ufw
  ufw allow OpenSSH
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
fi

sleep 3
say "Done. Checks:"
systemctl --no-pager --lines=0 status nextastore-ai || true
curl -fsS http://127.0.0.1:4100/ && echo
echo
echo "Next: run   sudo -u nexi bash -c 'cd $APP_DIR && npm run check-ollama'"
echo "      then  free -h    and    ollama ps     (send me both)."
echo "Logs:       journalctl -u nextastore-ai -f"
