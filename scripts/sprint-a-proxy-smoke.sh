#!/usr/bin/env bash
set -euo pipefail

SUB_BASE="${SUB_BASE:-http://127.0.0.1:8780}"
SUB_USER="${SUB_USER:-admin1}"
SUB_PASS="${SUB_PASS:-Sw123123}"
SOURCE_ID="${SOURCE_ID:-7}"
TIMEOUT="${TIMEOUT:-20}"

ok(){ echo "[OK] $*"; }
fail(){ echo "[FAIL] $*"; exit 1; }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
COOKIE="$TMP_DIR/cookie.txt"

curl -fsS -m "$TIMEOUT" -c "$COOKIE" \
  -H 'content-type: application/json' \
  -d "{\"username\":\"$SUB_USER\",\"password\":\"$SUB_PASS\"}" \
  "$SUB_BASE/api/auth/login" > "$TMP_DIR/sub-login.json" || fail "sub login failed"
python3 - "$TMP_DIR/sub-login.json" <<'PY' || fail "sub login invalid"
import json,sys
obj=json.load(open(sys.argv[1],'r',encoding='utf-8'))
assert obj.get('ok') is True
PY
ok "sub login"

curl -fsS -m "$TIMEOUT" -b "$COOKIE" \
  "$SUB_BASE/panel-proxy/$SOURCE_ID/" > "$TMP_DIR/panel.html" || fail "panel-proxy page failed"
python3 - "$TMP_DIR/panel.html" <<'PY' || fail "panel page missing sprint-a patch"
import sys
s=open(sys.argv[1],'r',encoding='utf-8',errors='ignore').read()
assert 'proxyBasePath' in s
assert 'async function api' in s
PY
ok "panel-proxy html patched"

code=$(curl -sS -m "$TIMEOUT" -o "$TMP_DIR/proxy-login.json" -w '%{http_code}' -b "$COOKIE" \
  -H 'content-type: application/json' \
  -d '{"username":"admin1","password":"Sw123123"}' \
  "$SUB_BASE/panel-proxy/$SOURCE_ID/auth/login")
[[ "$code" == "200" ]] || fail "proxy auth/login http=$code"
python3 - "$TMP_DIR/proxy-login.json" <<'PY' || fail "proxy auth/login invalid json"
import json,sys
obj=json.load(open(sys.argv[1],'r',encoding='utf-8'))
assert obj.get('success') is True
assert obj.get('token')
PY
ok "proxy auth/login"

echo "Sprint A proxy smoke passed (source=$SOURCE_ID)"
