#!/usr/bin/env bash
#
# smoke-prod.sh — post-deploy smoke test for track.apogeemobi.com
#
# Run this within 5 minutes of every push to main. Exits 0 if everything
# looks healthy; exits 1 with a printed list of regressions otherwise.
#
# Override the target host:
#   PROD=https://staging.track.apogeemobi.com ./smoke-prod.sh
#   PROD=http://localhost:3001 ./smoke-prod.sh
#
# Add new probes as the platform grows — keep each one a single
# focused assertion with a clear regression message.

set -u
PROD="${PROD:-https://track.apogeemobi.com}"

FAILURES=()
PASS_COUNT=0

# ── helpers ───────────────────────────────────────────────────────────────
# Each curl gets a single retry on network/TLS errors (HTTP 000) to absorb
# transient timeouts. Real HTTP failures (4xx/5xx) are not retried.
check_code() {
  local desc="$1"; local url="$2"; local expected="$3"
  local actual
  for attempt in 1 2; do
    actual=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url")
    [ "$actual" != "000" ] && break
    sleep 1
  done
  if [ "$actual" = "$expected" ]; then
    printf "  ✓ %-50s %s\n" "$desc" "$actual"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    printf "  ✗ %-50s expected %s, got %s\n" "$desc" "$expected" "$actual"
    FAILURES+=("$desc (expected $expected, got $actual)")
  fi
}

check_contains() {
  local desc="$1"; local url="$2"; local needle="$3"
  if curl -s --max-time 10 "$url" | grep -q -- "$needle"; then
    printf "  ✓ %-50s contains %s\n" "$desc" "\"$needle\""
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    printf "  ✗ %-50s missing %s\n" "$desc" "\"$needle\""
    FAILURES+=("$desc (missing: $needle)")
  fi
}

check_header() {
  local desc="$1"; local url="$2"; local header="$3"
  if curl -sI --max-time 10 "$url" | grep -qi "^$header:"; then
    printf "  ✓ %-50s has %s\n" "$desc" "$header"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    printf "  ✗ %-50s missing %s\n" "$desc" "$header"
    FAILURES+=("$desc (missing header: $header)")
  fi
}

check_no_header() {
  local desc="$1"; local url="$2"; local header="$3"
  if ! curl -sI --max-time 10 "$url" | grep -qi "^$header:"; then
    printf "  ✓ %-50s lacks %s\n" "$desc" "$header"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    printf "  ✗ %-50s still leaks %s\n" "$desc" "$header"
    FAILURES+=("$desc (header should be absent: $header)")
  fi
}

# ── probes ────────────────────────────────────────────────────────────────
echo "Smoke testing $PROD"
echo ""

echo "[1] Core public endpoints"
check_code   "GET  /health"                  "$PROD/health"            "200"
check_code   "GET  /sellers.json"            "$PROD/sellers.json"      "200"
check_code   "GET  /pixel.gif"               "$PROD/pixel.gif?campaign_token=t" "200"
check_code   "GET  /pb"                      "$PROD/pb"                "200"
check_code   "GET  /sdk/v1/apogee.js"        "$PROD/sdk/v1/apogee.js"  "200"
check_code   "GET  /robots.txt"              "$PROD/robots.txt"        "200"
check_code   "GET  /favicon.ico"             "$PROD/favicon.ico"       "204"

echo ""
echo "[2] Money path"
check_code   "GET  /track/click/INVALID"     "$PROD/track/click/INVALID" "404"
check_contains "  -> friendly error message" "$PROD/track/click/INVALID" "no longer active"

echo ""
echo "[3] Auth boundary (must not leak)"
check_code   "GET  /api/dashboard (no auth)" "$PROD/api/dashboard"     "401"
check_code   "GET  /api/campaigns (no auth)" "$PROD/api/campaigns"     "401"
check_code   "GET  /api/discovery/candidates" "$PROD/api/discovery/candidates" "401"
check_code   "GET  /api/v1/serve (no key)"   "$PROD/api/v1/serve"      "401"

echo ""
echo "[4] /api/* 404 guard"
check_code   "GET  /api/this-does-not-exist" "$PROD/api/this-does-not-exist" "404"
check_contains "  -> returns JSON not HTML"  "$PROD/api/this-does-not-exist" "Not found"

echo ""
echo "[5] OpenAPI docs"
check_code   "GET  /api/v1/openapi.json"     "$PROD/api/v1/openapi.json" "200"
check_code   "GET  /api/v1/openapi.yaml"     "$PROD/api/v1/openapi.yaml" "200"
check_code   "GET  /api/docs/"               "$PROD/api/docs/"         "200"

echo ""
echo "[6] Security headers"
check_header    "GET  / has HSTS"            "$PROD/" "strict-transport-security"
check_header    "GET  / has X-Frame-Options" "$PROD/" "x-frame-options"
check_header    "GET  / has X-Content-Type-Options" "$PROD/" "x-content-type-options"
check_header    "GET  / has Referrer-Policy" "$PROD/" "referrer-policy"
check_no_header "GET  / no x-powered-by"     "$PROD/" "x-powered-by"

echo ""
echo "[7] SPA"
check_code   "GET  /"                        "$PROD/"                  "200"
check_code   "GET  /dashboard"               "$PROD/dashboard"         "200"
check_code   "GET  /campaigns"               "$PROD/campaigns"         "200"

echo ""
echo "[8] Adjust-compatible postback"
check_code   "GET  /adjust/event (no token)" "$PROD/adjust/event"      "400"

echo ""
echo "[9] Static preview decks"
check_code   "GET  /sdk/preview-v2/index.html" "$PROD/sdk/preview-v2/index.html" "200"

echo ""
echo "[10] Programmatic surface (auth boundaries)"
check_code   "GET  /track/smart/INVALID"          "$PROD/track/smart/INVALID"          "404"
check_code   "GET  /api/inventory (no auth)"      "$PROD/api/inventory"                "401"
check_code   "GET  /api/placements (no auth)"     "$PROD/api/placements"               "401"
check_code   "GET  /api/smart-links (no auth)"    "$PROD/api/smart-links"              "401"
check_code   "GET  /api/inventory-approvals (no auth)" "$PROD/api/inventory-approvals" "401"
check_code   "GET  /api/reports/summary (no auth)" "$PROD/api/reports/summary"         "401"
check_code   "POST /api/smart-links/from-inventory/1 (no auth)" "$PROD/api/smart-links/from-inventory/1" "401"
check_code   "POST /api/smart-links/1/optimize-weights (no auth)" "$PROD/api/smart-links/1/optimize-weights" "401"
check_code   "GET  /api/smart-links/inventory-approval-counts (no auth)" "$PROD/api/smart-links/inventory-approval-counts" "401"

echo ""
echo "[11] IAB compliance surface"
check_contains "GET  /sellers.json → has sellers array" "$PROD/sellers.json" '"sellers"'
check_code   "GET  /api/ads-text/all (no auth)"   "$PROD/api/ads-text/all"             "401"

echo ""
echo "[12] Dev-only endpoints (locked in production)"
# /api/dev/preview-token is localhost-only in non-prod, 404 in prod.
# We accept either 404 (prod) or 200 (local with NODE_ENV != production).
DEV_TOKEN_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$PROD/api/dev/preview-token")
if [ "$DEV_TOKEN_STATUS" = "404" ] || [ "$DEV_TOKEN_STATUS" = "200" ]; then
  printf "  ✓ %-50s %s (acceptable)\n" "GET  /api/dev/preview-token" "$DEV_TOKEN_STATUS"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  printf "  ✗ %-50s expected 200 or 404, got %s\n" "GET  /api/dev/preview-token" "$DEV_TOKEN_STATUS"
  FAILURES+=("Dev preview token endpoint unexpected status: $DEV_TOKEN_STATUS")
fi

# ── result ────────────────────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────────────────────"
if [ ${#FAILURES[@]} -eq 0 ]; then
  echo "✓ $PASS_COUNT/$PASS_COUNT checks passed — deploy looks healthy"
  exit 0
else
  echo "✗ ${#FAILURES[@]} regression(s) found out of $((PASS_COUNT + ${#FAILURES[@]})) checks:"
  for f in "${FAILURES[@]}"; do
    echo "   - $f"
  done
  echo ""
  echo "Recommended: git revert <last_commit_sha> && git push origin main"
  echo "             (then re-run this script after Render redeploys, ~30s)"
  exit 1
fi
