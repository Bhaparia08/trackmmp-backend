<!--
Read docs/REVIEW-STANDARDS.md before opening this PR.
Operating model: one task = one branch = one PR. No direct main push. No agent merges. No agent deploys.
-->

## Summary
<!-- One-sentence elevator pitch. What changes for users / operators / advertisers? -->

## Risk class
<!-- Tick exactly one. See docs/REVIEW-STANDARDS.md for definitions. -->
- [ ] HARD STOP — Frozen tracking layer (`routes/track.js`, `routes/postbacks.js`, `routes/acquisition.js`, `utils/postbackHandler.js`, `utils/macroReplace.js`, `utils/webhookRetry.js`) — **explicit "modify tracking" approval required**
- [ ] HIGH — Auth + security (`routes/auth.js`, JWT, password reset, 2FA, rate limits, CORS, helmet)
- [ ] HIGH — Payments + invoices (`routes/invoices.js`, currency, payouts, ledger)
- [ ] HIGH — DB schema migrations (`db/init.js`)
- [ ] HIGH — Deploy / config / security infra (`server.js`, env, CI workflows)
- [ ] NORMAL — UI only (non-money, non-auth pages)
- [ ] NORMAL — Connector logic (non-frozen network adapters)
- [ ] CHORE — Docs, deps, cleanup

## Files changed
<!-- Output of `git diff --name-only origin/main..HEAD`. Keep it tight. -->
```
```

## Local checks
<!-- Output of `scripts/review.sh`. Quote the pass/fail line for each. -->
- [ ] `scripts/review.sh` exits 0
- [ ] `node -c` passes on every changed `.js` file
- [ ] `bash -n` passes on every changed `.sh` file
- [ ] `npm run smoke:local` runs cleanly against a local backend (or N/A if no backend changes)

## Cross-check verdict (required for HIGH and HARD-STOP risk classes)
<!-- Paste the second-AI verdicts here. See docs/CROSS-CHECK-TEMPLATE.md for the prompt. -->
- [ ] Second AI used: <name + model>
- [ ] All CONFIRMED findings fixed on this branch
- [ ] Any newly-surfaced findings addressed or explicitly deferred

## Frozen-layer impact
- [ ] Touches `routes/track.js`? **YES / NO** — if YES, paste the explicit operator approval here.
- [ ] Touches any other frozen file? **YES / NO** — if YES, same.
- [ ] Indirect effect on `/track/click/*`, `/pb`, `/acquisition`, or postback firing under realistic load? Explain.

## Acceptance criteria before merge
<!-- Tickable, concrete, verifiable. Generic "looks good" doesn't count. -->
- [ ]
- [ ]
- [ ]

## Post-merge verification plan
<!-- What you'll run within 5 minutes of the Render redeploy. -->
- [ ] `bash scripts/smoke-prod.sh` against `https://track.apogeemobi.com` returns 0/0 regressions
- [ ] Tracking endpoints continue returning 200/302 on real traffic — eyeball Render logs for 5 minutes

## Notes for the reviewer
<!-- Anything that helps the human merger decide. -->
