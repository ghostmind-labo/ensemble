#!/bin/bash
# Runs under varlock: CLOUDFLARED_CREDS comes from Vault.
set -euo pipefail

CREDS_DIR=/root/.cloudflared
mkdir -p "$CREDS_DIR"
echo "$CLOUDFLARED_CREDS" | base64 -d > "$CREDS_DIR/cert.pem"

CONFIG="/etc/cloudflared/config/ingress.${APP_ENV}.yaml"
[ -f "$CONFIG" ] || { echo "missing $CONFIG"; exit 1; }
TUNNEL=$(grep '^tunnel:' "$CONFIG" | awk '{print $2}')

# Create the tunnel the first time; its credentials JSON lives in the tunnel-creds volume.
if cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$TUNNEL"; then
  if ! ls "$CREDS_DIR"/*.json >/dev/null 2>&1; then
    echo "tunnel $TUNNEL exists but its credentials are gone: recreating it"
    cloudflared tunnel delete -f "$TUNNEL"
    cloudflared tunnel create "$TUNNEL"
  fi
else
  echo "creating tunnel $TUNNEL"
  cloudflared tunnel create "$TUNNEL"
fi

grep -E '^\s*- hostname:' "$CONFIG" | awk '{print $3}' | while read -r host; do
  echo "routing $host -> $TUNNEL"
  cloudflared tunnel route dns --overwrite-dns "$TUNNEL" "$host"
done

run() { cloudflared tunnel --config "$CONFIG" run "$TUNNEL"; }
if [ "$APP_ENV" = "prod" ]; then
  # varlock stays PID 1: the single-use Vault login can't be repeated, so restart in place
  while true; do run || echo "cloudflared exited ($?), restarting"; sleep 2; done
else
  exec cloudflared tunnel --config "$CONFIG" run "$TUNNEL"
fi
