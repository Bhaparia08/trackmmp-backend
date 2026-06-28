# Cross-check prompt template

Paste this into a second AI (ChatGPT / Gemini / Codex / a different Claude session) **along with** either:

- the relevant source files attached, OR
- the `docs/reviews/YYYY-MM-DD-<branch>.md` findings file from `scripts/review.sh`, OR
- the GitHub PR URL (if the AI can browse it), OR
- a paste of the diff and findings.

The template is hardened against "looks good to me" hand-waving — it forces the second AI to vote per finding with a
quoted line.

---

```
You are a senior application-security reviewer doing INDEPENDENT verification of code-review findings on a Node.js /
Express + React platform called TrackMMP (affiliate-attribution SaaS, live, integrated with AppsFlyer / Adjust /
Branch / Click Dealer / Trackier / Affise).

DO NOT generate new top-level findings unless asked. DO NOT suggest fixes yet. Your job is to vote on each of the
findings below, returning ONE of four verdicts per finding:

  CONFIRMED       — bug is real; quote the exact line + the inputs/state that trigger it.
  PARTIALLY_TRUE  — mechanism is real but the failure scenario as written is wrong or overstated; explain how.
  REFUTED         — code does not say what the finding claims; quote the line that disproves it.
  FALSE_POSITIVE  — code says what the finding claims, but a guard elsewhere (other middleware, env check, separate
                    code path) makes the failure unreachable; name the guard.

Constraints you MUST respect:
  - The tracking layer (routes/track.js, routes/postbacks.js, routes/acquisition.js, utils/postbackHandler.js,
    utils/macroReplace.js, utils/webhookRetry.js) is FROZEN. Findings should not require editing those files. Flag any
    finding that DOES touch them.
  - The platform deploys to Render with NODE_ENV=production by default, behind Cloudflare. server.js sets
    app.set('trust proxy', 1).
  - The login endpoint already exists; rate-limit findings refer to limiters added in routes/auth.js.
  - Sole reviewer/operator is @Bhaparia08 — there is no second human reviewer on call.

For each finding, output exactly:

  ## Finding N
  Verdict: <CONFIRMED|PARTIALLY_TRUE|REFUTED|FALSE_POSITIVE>
  Line: <file:line — quote the line>
  Reasoning: <2-3 sentences, concrete>
  Severity if real: <CRITICAL|HIGH|MEDIUM|LOW>

After all findings, write a one-paragraph summary covering:
  - how many of each verdict
  - which findings the first reviewer MISSED (if any) that you would add
  - whether any finding touches the FROZEN tracking layer
  - your overall recommendation: BLOCK MERGE / FIX BEFORE MERGE / MERGE OK / LOW-SEVERITY OK TO DEFER

If the source files were attached, read them. If only a findings file was attached, vote based on the quoted code in
that file but flag any finding where you would want the underlying file to confirm.

Findings to vote on:

<paste findings here, one block per finding — see format below>

[1] <SEVERITY> — <ONE-LINE SUMMARY>
File: <path:line>
Claim: <full mechanism in 2-4 sentences. What input, state, timing, or platform makes it fire. What the wrong output
or crash is.>

[2] ...
```

---

## Format note — copy the JSON output from `/code-review` directly

The `/code-review` skill returns findings as a JSON array. To prepare the prompt:

1. Take each JSON object and transform it into the `[N] SEVERITY — SUMMARY / File / Claim` block above.
2. Or just paste the JSON and prefix it with: *"Each object in the JSON array below is a finding to vote on; treat
   `file`, `line`, `summary`, and `failure_scenario` as the claim. Vote per object using the rubric above."*

Both work. The JSON-paste route is faster; the prose route is easier for a fresh reader.

## Where to send it

| AI | Notes |
| --- | --- |
| ChatGPT (Plus / Team) | Attach files via the paperclip. Use a model with vision/code understanding (GPT-4o, GPT-5 if released). |
| Claude.ai (web) | Attach files via the paperclip. Use Claude Sonnet/Opus. Do NOT use the same session that produced the first review. |
| Gemini (gemini.google.com) | Attach files via the Drive button. Use Gemini 1.5/2 Pro. |
| Codex / OpenAI Codex CLI | Pass the prompt + file paths on the local repo. |
| A separate Claude Code session | Open a fresh terminal, `cd` to the repo, paste the template. The second session has no context contamination from the first. |

## What to do with the result

Three outcomes likely:

| Second AI says... | Action |
| --- | --- |
| All findings CONFIRMED + possibly adds new ones | Start patching. Prioritise the new ones too. |
| Some REFUTED / FALSE_POSITIVE | Read the second AI's reasoning + the cited line. If their reasoning is correct, drop those findings. If wrong, push back. |
| "Tracking layer would be affected" | That's the safety net you're testing for. Bring it back to the first reviewer and re-verify against the frozen-file list. |

## Hardening tips

- If the second AI returns "looks good to me" without quoting lines → push back: *"Quote the exact line for each finding. I don't accept hand-waves."*
- If the second AI tries to merge or push for you → it's a different agent in a different repo; ignore that suggestion and follow the workflow in `docs/REVIEW-STANDARDS.md` step 11 (operator merges manually).
- If the second AI's verdict contradicts the first reviewer, name the conflict in the PR comment thread + decide as operator.
