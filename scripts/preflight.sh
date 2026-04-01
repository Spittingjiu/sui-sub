#!/usr/bin/env bash
set -euo pipefail

echo "[1/4] node syntax check"
node --check server.js >/dev/null

echo "[2/4] template json check"
if [[ -f /tmp/clash-generic-template/clash-template.json ]]; then
  node scripts/validate-template.mjs /tmp/clash-generic-template/clash-template.json
else
  echo "skip: /tmp/clash-generic-template/clash-template.json not found"
fi

echo "[3/4] git status"
git status --short

echo "[4/4] service dry info"
systemctl is-active suisub.service >/dev/null && echo "suisub.service: active" || echo "suisub.service: inactive"

echo "preflight done"
