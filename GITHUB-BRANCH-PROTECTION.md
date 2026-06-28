# GitHub branch-protection settings to apply manually

This document describes the settings to apply at
`https://github.com/Bhaparia08/trackmmp-backend/settings/branches` so the
11-step workflow in `docs/REVIEW-STANDARDS.md` is also enforced server-side,
not just by goodwill.

Apply by hand once — this file is the single source of truth for what the
settings should be, so they can be audited or replayed later.

## Settings for `main`

Open `Settings` → `Branches` → `Branch protection rules` → `Add branch ruleset`
(GitHub's "Rulesets" UI is the newer interface; classic "Branch protection
rules" works identically). Target the `main` branch.

### Required: enforce PR-only flow

| Setting | Value | Reason |
| --- | --- | --- |
| **Restrict deletions** | ON | Block accidental `git push --delete origin main`. |
| **Restrict force pushes** | ON | Block force-push to main from anywhere. |
| **Require a pull request before merging** | ON | The headline rule — no direct push. |
| └─ **Required approvals** | 1 | Sole reviewer is operator (you). When the team grows, raise to 2. |
| └─ **Dismiss stale pull request approvals when new commits are pushed** | ON | Force re-review after every new commit. |
| └─ **Require review from Code Owners** | ON | Honours `CODEOWNERS`. Frozen tracking files need owner approval automatically. |
| └─ **Require approval of the most recent reviewable push** | **OFF (for now)** | With sole operator/reviewer `@Bhaparia08`, this would block self-merge entirely — the author of the latest commit cannot also approve it. Turn ON only after a second human reviewer or bot account exists. See "When to revisit" below. |

### Required: CI must be green

| Setting | Value | Reason |
| --- | --- | --- |
| **Require status checks to pass** | ON | Couple branch protection to CI. |
| └─ **Require branches to be up to date before merging** | ON | Force rebase if main moved while the PR was open. |
| └─ **Required status check** | `Smoke tests / smoke` (from `.github/workflows/ci.yml`) | The smoke workflow must pass on the PR head. |

### Required: linear history

| Setting | Value | Reason |
| --- | --- | --- |
| **Require linear history** | ON | No merge commits on main. PRs land as squash or rebase. |

### Recommended

| Setting | Value | Reason |
| --- | --- | --- |
| **Require conversation resolution before merging** | ON | All review threads must be resolved. |
| **Require signed commits** | OFF (for now) | Not configured; revisit when SSH key + GPG flow is set up. |
| **Lock branch** | OFF | Locking main blocks merges too; we want PR-driven merges. |
| **Allow specified actors to bypass required pull requests** | EMPTY | Even the operator cannot bypass — process is process. |

### Settings to AVOID

- ❌ Allow force pushes — never on main
- ❌ Allow deletions — never on main
- ❌ Bypass list with the operator account — defeats the rule

## Settings for `feat/**`, `wip/**`, `fix/**`, `chore/**`

No protection required. These branches are throw-away work; the protection
lives on `main`. If a feature branch is needed by collaborators (later), apply
a relaxed ruleset that prevents force-push only.

## Settings for `wip/**` specifically

| Setting | Value | Reason |
| --- | --- | --- |
| **Require status checks to pass** | OFF | A `wip/...` branch is a paper trail, not a merge candidate. Don't gate it. |
| **Restrict merge** | (do not auto-protect) | Operator manually decides if/when to promote a `wip/...` PR. |

## Repository-level settings

Open `Settings` → `General` → `Pull Requests`.

| Setting | Value |
| --- | --- |
| **Allow merge commits** | OFF |
| **Allow squash merging** | ON (default — `Pull request title and description`) |
| **Allow rebase merging** | ON |
| **Always suggest updating pull request branches** | ON |
| **Automatically delete head branches** | ON — for `feat/**`, `fix/**`, `chore/**` after merge |

Leave `wip/**` branches manually deleted by the operator (they're paper trails,
not throwaways).

## Settings → Actions → General

| Setting | Value | Reason |
| --- | --- | --- |
| **Workflow permissions** | Read repository contents | Default — least privilege. |
| **Allow GitHub Actions to create and approve pull requests** | OFF | Agents should NOT auto-merge their own PRs. |

## Verification

After applying the rules, verify with:

```bash
# Should be rejected by GitHub (not by the local hook).
git push origin main
```

Expected response:

```
remote: error: GH006: Protected branch update failed for refs/heads/main.
remote: error: At least 1 approving review is required by reviewers with write access.
```

If the push succeeds, branch protection is not active — re-check the ruleset.

## When to revisit

- Team grows beyond one operator → raise `Required approvals` from 1 to 2.
- A second human reviewer or bot account is added → enable `Require approval of the most recent reviewable push` so the author cannot self-approve their final commit. Leave OFF while sole-operator, otherwise self-merge is impossible.
- A signed-commits policy is rolled out → enable `Require signed commits`.
- A staging environment is added → add a `staging` branch ruleset mirroring
  `main` but with a relaxed approval count.
- The audit log table is monitored externally → tighten "Require status
  checks" to also include a metrics-emit check, not just smoke.
