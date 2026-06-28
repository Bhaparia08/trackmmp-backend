# TrackMMP review standards

This document defines how every change reaches production. It is read by humans and by AI agents (Claude Code, ChatGPT,
Gemini, Codex, etc.). The rules below override any "we'll just push this real quick" instinct.

The platform is live and integrated with real advertiser MMPs (AppsFlyer, Adjust, Branch, Click Dealer, Trackier,
Affise). A bad merge can break live campaigns. Slow is fine, broken is not.

## The 11-step workflow

Every task — feature, fix, refactor, docs, dependency bump — follows the same loop:

```
1.  Work on a feature branch only.                    (never main)
2.  Run scripts/review.sh.                            (local self-check)
3.  Show branch / status / diff / files / tests.      (visible before push)
4.  Wait for explicit operator approval.              (no auto-push)
5.  Push branch only.                                  (never main)
6.  Open PR (draft).                                  (one task = one branch = one PR)
7.  CI runs.                                          (.github/workflows/ci.yml)
8.  Second-AI cross-check on the PR/latest commit.    (paste CROSS-CHECK-TEMPLATE.md)
9.  Fix only valid findings on the same branch.       (no scope creep)
10. Repeat review on the latest commit.               (each push re-triggers)
11. Operator merges manually via GitHub UI.           (no auto-merge)
```

**No agent merges. No agent deploys.** Render auto-deploys from `main`, so step 11 is also the deploy gate.

## Risk classification — which review path applies

| Class | Examples | Cross-check required? | Notes |
| --- | --- | --- | --- |
| **HARD STOP — Frozen tracking** | `routes/track.js`, `routes/postbacks.js`, `routes/acquisition.js`, `utils/postbackHandler.js`, `utils/macroReplace.js`, `utils/webhookRetry.js` | YES + explicit "modify tracking" approval | These files run the live attribution layer. Any edit needs the operator to type "modify tracking OK" before the agent stages it. |
| **HIGH — Auth + security** | `routes/auth.js`, JWT signing, API keys, rate limits, CORS, helmet, password reset, 2FA | YES | The last audit found 15 issues in this area — assume it's the worst-blast-radius surface. |
| **HIGH — Payments + invoices** | `routes/invoices.js`, currency conversion, payout calculation, balance ledger, anything that prints money | YES | Money paths get an independent verifier. |
| **HIGH — DB schema migrations** | `db/init.js`, new migrations | YES | Forward-only on prod. Once shipped, irreversible without a manual reverse migration. |
| **HIGH — Deploy / config / security infra** | `server.js` startup wiring, `.env.production` references, helmet config, CORS allowlist, CI workflow files | YES | Wrong settings here can disable defenses silently. |
| **NORMAL — UI only** | `frontend/src/**` except auth/invoice pages, preview decks, copy edits in non-money flows | Optional | Single review pass is enough for cosmetic changes. |
| **NORMAL — Connector logic (non-frozen)** | `utils/connectors/<network>.js` (Trackier, Affise, etc.) | Operator's call | Connector changes don't run on every click but DO affect campaign import; flag if the change could overwrite operator-edited fields. |
| **HARD STOP — Dirty working tree** | Any agent invocation while files are uncommitted on the wrong branch | n/a | `scripts/review.sh` refuses to run. Park or commit first. |

## Hard stops

These conditions block any further action until resolved:

- Working tree has uncommitted changes on `main`.
- Branch is `main` and the requested action involves a commit/push.
- A frozen tracking file appears in the diff without `ALLOW_TRACKING_MODIFY=1` set in the environment.
- The current `git push` would target `origin/main` directly.
- `gh auth status` reports the token lacks a scope the action needs.
- An agent is about to call `git merge` or `git push --force` on `main`.

`scripts/review.sh` enforces the first four. The rest are operator + CI responsibility.

## Deploy consent

> Render auto-deploys from `main`. Therefore merging a PR to `main` is the same as deploying to production.

Before any human merges:

1. CI must be green on the PR head.
2. The cross-check verdict (where required by risk class) must be reviewed.
3. Smoke against staging or local must have run successfully — `bash scripts/smoke-prod.sh` against `localhost:3001`
   or a staging URL.
4. The PR's "Acceptance criteria before merge" section must be ticked off in the PR body.

After merge:

5. Run `bash scripts/smoke-prod.sh` (no `PROD=` override = prod) within 5 minutes of the Render redeploy.
6. Watch `/health` + the tracking endpoints for 5 more minutes before declaring done.

## Severity scale (used in code-review findings)

| Severity | Definition | Block merge? |
| --- | --- | --- |
| CRITICAL | Active exploitation possible / live money lost / live attribution broken | YES |
| HIGH | Exploitable under realistic conditions / silent data corruption / monitoring blind spot | YES (block unless explicit waiver) |
| MEDIUM | UX regression / non-prod-blocking config drift / operational hygiene | Operator's call |
| LOW | Code-quality / nit / future-proofing | No |

A finding's severity is named in the JSON output of the `/code-review` skill or the cross-check verdict; both feeds use
the same scale.

## When to cross-check (second AI)

Always cross-check for HIGH and HARD-STOP risk classes. The mechanism:

1. After `scripts/review.sh` runs, it writes `docs/reviews/YYYY-MM-DD-<branch-slug>.md` containing the diff summary +
   the first-pass findings.
2. Paste the contents of `docs/CROSS-CHECK-TEMPLATE.md` into a second AI (ChatGPT / Gemini / Codex), along with the
   findings file or attached source files.
3. Compare verdicts. If the second AI confirms most findings, fix them. If the second AI surfaces NEW findings, fix
   those too. If the two disagree, the operator decides.

For NORMAL-class changes, cross-check is optional — operator's judgment.

## Branch naming convention

| Prefix | Use | Example |
| --- | --- | --- |
| `feat/` | New feature, additive change | `feat/postback-retry-backoff` |
| `fix/` | Bug fix on existing behaviour | `fix/invoice-pdf-stream-error` |
| `chore/` | Cleanup, refactor, dep bump, docs | `chore/gitignore-sdk-folders` |
| `wip/` | Parked work for paper trail, NOT mergeable | `wip/track-cd-edits-2026-06-27` |
| `experimental/` | Throwaway exploration | `experimental/postgres-port` |

One branch per logical change. If a branch grows multiple concerns, split into two PRs.

## Frozen tracking layer — the standing rule

Verified stable as of 2026-06-18. Files:

```
routes/track.js
routes/postbacks.js
routes/acquisition.js
utils/postbackHandler.js
utils/macroReplace.js
utils/webhookRetry.js
```

These run the live click ingestion, attribution, and outbound postback layer. The platform is processing real campaign
traffic against AppsFlyer / Adjust / Branch / Click Dealer / Trackier / Affise integrations. **Do not edit these files
without explicit "modify tracking" approval from the operator.** Use `wip/...` branches + draft PRs for any parked
edits (see PR #1 as the worked example).

## Pre-existing references

- Per-feature pitfalls log: `memory/project_trackmmp_pitfalls.md` (read before any new connector/integration)
- Operating model rule: never push to `main` directly, never merge, never deploy — see `memory/feedback_no_direct_main_push.md`
- Tracking frozen rule: `memory/feedback_tracking_layer_frozen.md`
- Cross-check template: `docs/CROSS-CHECK-TEMPLATE.md` (this directory)
- Branch-protection settings to apply manually in GitHub: `GITHUB-BRANCH-PROTECTION.md` (repo root)
