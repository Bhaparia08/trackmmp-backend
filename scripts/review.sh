#!/usr/bin/env bash
#
# review.sh — pre-push local review checks for TrackMMP.
#
# What it does (steps 2-3 of the 11-step workflow in docs/REVIEW-STANDARDS.md):
#   1. Refuse to run on dirty working tree.
#   2. Refuse to run on main.
#   3. Refuse if a frozen tracking-layer file is in the diff, unless
#      ALLOW_TRACKING_MODIFY=1 is set in the environment.
#   4. node -c on every changed *.js (syntax check).
#   5. JSON.parse on changed package.json (if present in diff).
#   6. bash -n on every changed *.sh.
#   7. Optionally run npm run smoke:local — set SKIP_SMOKE=1 to skip.
#   8. Emit a review log at docs/reviews/YYYY-MM-DD-<branch-slug>.md
#      containing the diff summary, the changed-file list, the test results,
#      and a ready-to-paste cross-check prompt.
#
# This is a self-check before push, not a merge gate. The merge gate is CI +
# the operator.
#
# Exit 0 if all checks pass, 1 if any check fails. Re-run after fixing.

set -u

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

FROZEN_FILES=(
  "routes/track.js"
  "routes/postbacks.js"
  "routes/acquisition.js"
  "utils/postbackHandler.js"
  "utils/macroReplace.js"
  "utils/webhookRetry.js"
)

FAILURES=()
PASS_COUNT=0
WARNINGS=()

note_pass() {
  printf "  ✓ %s\n" "$1"
  PASS_COUNT=$((PASS_COUNT + 1))
}
note_fail() {
  printf "  ✗ %s\n" "$1"
  FAILURES+=("$1")
}
note_warn() {
  printf "  ⚠ %s\n" "$1"
  WARNINGS+=("$1")
}

echo "─────────────────────────────────────────────────────"
echo " TrackMMP review.sh — pre-push self-check"
echo "─────────────────────────────────────────────────────"

# ── 1. branch must not be main ───────────────────────────────────────────────
BRANCH="$(git branch --show-current)"
echo ""
echo "[1] Branch is not main"
if [ "$BRANCH" = "main" ]; then
  note_fail "currently on main — create a feature branch first"
else
  note_pass "on '$BRANCH'"
fi

# ── 2. working tree must be clean ────────────────────────────────────────────
echo ""
echo "[2] Working tree is clean"
if [ -z "$(git status --short)" ]; then
  note_pass "no uncommitted changes"
else
  note_fail "working tree dirty — commit or stash before running review"
  git status --short | sed 's/^/      /'
fi

# Stop here if either of the first two checks fail.
if [ ${#FAILURES[@]} -gt 0 ]; then
  echo ""
  echo "─────────────────────────────────────────────────────"
  echo " HARD STOP — fix the failures above before retrying."
  echo "─────────────────────────────────────────────────────"
  exit 1
fi

# ── 3. compute the diff scope vs origin/main ────────────────────────────────
echo ""
echo "[3] Diff scope vs origin/main"
git fetch -q origin main 2>/dev/null || true
CHANGED_FILES="$(git diff --name-only origin/main..HEAD 2>/dev/null)"
if [ -z "$CHANGED_FILES" ]; then
  note_warn "no commits ahead of origin/main on '$BRANCH' — nothing to review"
  CHANGED_COUNT=0
else
  CHANGED_COUNT=$(echo "$CHANGED_FILES" | wc -l | tr -d ' ')
  note_pass "$CHANGED_COUNT files changed on '$BRANCH' since origin/main"
  echo "$CHANGED_FILES" | sed 's/^/      /'
fi

# ── 4. frozen-layer guard ────────────────────────────────────────────────────
echo ""
echo "[4] Frozen tracking-layer guard"
TOUCHED_FROZEN=()
for f in "${FROZEN_FILES[@]}"; do
  if echo "$CHANGED_FILES" | grep -qxF "$f"; then
    TOUCHED_FROZEN+=("$f")
  fi
done

if [ ${#TOUCHED_FROZEN[@]} -eq 0 ]; then
  note_pass "no frozen tracking-layer files touched"
elif [ "${ALLOW_TRACKING_MODIFY:-0}" = "1" ]; then
  note_warn "frozen files touched — but ALLOW_TRACKING_MODIFY=1 is set, allowing:"
  for f in "${TOUCHED_FROZEN[@]}"; do
    echo "      ⚠ $f"
  done
  echo "      (you are claiming explicit 'modify tracking' approval — this MUST be paper-trailed in the PR description)"
else
  note_fail "frozen tracking-layer files modified without ALLOW_TRACKING_MODIFY=1:"
  for f in "${TOUCHED_FROZEN[@]}"; do
    echo "      ✗ $f"
  done
  echo "      Either (a) revert these files, (b) park them on a wip/ branch, or"
  echo "      (c) get explicit 'modify tracking' approval from the operator AND re-run with"
  echo "      ALLOW_TRACKING_MODIFY=1 ./scripts/review.sh"
fi

# ── 5. syntax checks on changed code ────────────────────────────────────────
echo ""
echo "[5] Syntax checks on changed files"
JS_CHECKED=0
SH_CHECKED=0
JSON_CHECKED=0
if [ -n "$CHANGED_FILES" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    # node -c on changed JS (skip files that no longer exist on disk — deleted)
    if [[ "$f" == *.js ]] && [ -f "$f" ]; then
      if node -c "$f" 2>/tmp/review-sh-err; then
        JS_CHECKED=$((JS_CHECKED + 1))
      else
        note_fail "node -c failed on $f"
        sed 's/^/        /' < /tmp/review-sh-err
      fi
    fi
    if [[ "$f" == *.sh ]] && [ -f "$f" ]; then
      if bash -n "$f" 2>/tmp/review-sh-err; then
        SH_CHECKED=$((SH_CHECKED + 1))
      else
        note_fail "bash -n failed on $f"
        sed 's/^/        /' < /tmp/review-sh-err
      fi
    fi
    if [ "$f" = "package.json" ] && [ -f "$f" ]; then
      if node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" 2>/tmp/review-sh-err; then
        JSON_CHECKED=$((JSON_CHECKED + 1))
      else
        note_fail "package.json is not valid JSON"
        sed 's/^/        /' < /tmp/review-sh-err
      fi
    fi
  done <<<"$CHANGED_FILES"
fi
note_pass "$JS_CHECKED .js files parsed (node -c)"
note_pass "$SH_CHECKED .sh files parsed (bash -n)"
note_pass "$JSON_CHECKED package.json files parsed"

# ── 6. optional smoke ───────────────────────────────────────────────────────
echo ""
echo "[6] Local smoke (npm run smoke:local)"
if [ "${SKIP_SMOKE:-0}" = "1" ]; then
  note_warn "smoke skipped via SKIP_SMOKE=1 (set when no backend running)"
else
  # Only run smoke if backend changed (smoke is only meaningful then).
  if echo "$CHANGED_FILES" | grep -qE '\.(js|json|yml)$'; then
    if curl -sf -o /dev/null --max-time 3 http://localhost:3001/health; then
      if npm run smoke:local --silent 2>&1 | tail -5; then
        note_pass "smoke:local exited 0"
      else
        note_fail "smoke:local failed — see output above"
      fi
    else
      note_warn "localhost:3001 not reachable — start backend or pass SKIP_SMOKE=1"
    fi
  else
    note_warn "no backend-impacting files changed — skipping smoke"
  fi
fi

# ── 7. emit review log + cross-check prompt ─────────────────────────────────
echo ""
echo "[7] Emit review log"
DATE_TAG="$(date -u +%Y-%m-%d)"
BRANCH_SLUG="$(echo "$BRANCH" | tr '/' '-' | tr -c 'a-zA-Z0-9-' '-' | sed 's/-*$//')"
LOG_PATH="docs/reviews/${DATE_TAG}-${BRANCH_SLUG}.md"
mkdir -p docs/reviews
{
  echo "# Review log — $BRANCH"
  echo ""
  echo "- Date: $DATE_TAG"
  echo "- Branch: $BRANCH"
  echo "- Commit: $(git rev-parse HEAD)"
  echo "- Files changed: $CHANGED_COUNT"
  echo ""
  echo "## Files"
  echo ""
  if [ -n "$CHANGED_FILES" ]; then
    echo '```'
    echo "$CHANGED_FILES"
    echo '```'
  else
    echo "(none)"
  fi
  echo ""
  echo "## Diff stat"
  echo ""
  echo '```'
  git diff --stat origin/main..HEAD 2>/dev/null || echo "(no commits ahead of origin/main)"
  echo '```'
  echo ""
  echo "## Local checks"
  echo ""
  echo "- .js parsed (node -c): $JS_CHECKED"
  echo "- .sh parsed (bash -n): $SH_CHECKED"
  echo "- package.json parsed: $JSON_CHECKED"
  echo "- Frozen tracking files touched: ${#TOUCHED_FROZEN[@]}"
  if [ ${#TOUCHED_FROZEN[@]} -gt 0 ]; then
    for f in "${TOUCHED_FROZEN[@]}"; do
      echo "  - $f"
    done
  fi
  echo "- Local failures: ${#FAILURES[@]}"
  echo "- Warnings: ${#WARNINGS[@]}"
  echo ""
  echo "## Cross-check prompt — paste into ChatGPT / Gemini / a fresh Claude session"
  echo ""
  echo "See docs/CROSS-CHECK-TEMPLATE.md for the full template. Quick variant:"
  echo ""
  echo '```'
  echo "You are an independent code reviewer. Vote on each finding below as CONFIRMED / PARTIALLY_TRUE / REFUTED /"
  echo "FALSE_POSITIVE. Quote the exact line you're citing. Then list any findings the first reviewer missed."
  echo ""
  echo "Branch: $BRANCH"
  echo "Files changed: $CHANGED_FILES"
  echo ""
  echo "[paste the JSON findings array from /code-review here, OR run /code-review first and paste the output]"
  echo '```'
  echo ""
  echo "## Next steps"
  echo ""
  echo "1. Run /code-review on this branch (or invoke your reviewer of choice)."
  echo "2. Save the findings JSON into this file under 'Findings'."
  echo "3. Run the cross-check (see above) and save the second-AI verdicts under 'Cross-check verdicts'."
  echo "4. Fix CONFIRMED + non-trivial PLAUSIBLE findings on this branch."
  echo "5. Re-run review.sh."
  echo "6. Push branch + open draft PR (one task = one branch = one PR)."
} > "$LOG_PATH"
note_pass "review log written to $LOG_PATH"

# ── result ──────────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────────────────"
if [ ${#FAILURES[@]} -eq 0 ]; then
  echo " ✓ $PASS_COUNT checks passed"
  if [ ${#WARNINGS[@]} -gt 0 ]; then
    echo " ⚠ ${#WARNINGS[@]} warnings — review before push"
  fi
  echo "─────────────────────────────────────────────────────"
  exit 0
else
  echo " ✗ ${#FAILURES[@]} failures, $PASS_COUNT passes, ${#WARNINGS[@]} warnings"
  for f in "${FAILURES[@]}"; do
    echo "    - $f"
  done
  echo ""
  echo " Fix the failures above and re-run before pushing."
  echo "─────────────────────────────────────────────────────"
  exit 1
fi
