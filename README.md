# auto-doc

Turns pull-request review comments into documentation. When a reviewer states a
rule ("don't import services into entities"), the bot replies proposing it as a
doc entry. React 👍 and it gets folded into the repo's docs when the PR merges;
react 👎 and it's dropped. Nothing is written without a human 👍.

Two halves:

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `extract.yml` | review submitted / comment created or edited | Classifies each comment with Haiku. Rule-worthy ones get a threaded bot reply carrying a `<!-- auto-doc-bot ref:N -->` marker. |
| `integrate.yml` | PR merged | Collects marker replies with a 👍 and no 👎, decides covered / contradicts / missing per rule, and opens one doc PR. |

Reactions are the only validation surface — the integrator never reads comment
text for sentiment. A single 👎 from any non-bot user overrides any number of 👍s.

## Setup

**1. Add two workflow files.** Copy from [`examples/`](examples/):

```yaml
# .github/workflows/auto-doc-extract.yml
name: Auto-doc extract
on:
  pull_request_review: { types: [submitted] }
  pull_request_review_comment: { types: [edited] }
  issue_comment: { types: [created, edited] }
jobs:
  extract:
    uses: momentumdash/auto-doc/.github/workflows/extract.yml@v1
    secrets: inherit
```

```yaml
# .github/workflows/auto-doc-integrate.yml
name: Auto-doc integrate
on:
  pull_request: { types: [closed] }
jobs:
  integrate:
    uses: momentumdash/auto-doc/.github/workflows/integrate.yml@v1
    secrets: inherit
```

Triggers have to live in the calling repo — GitHub doesn't let a reusable
workflow declare its own. Everything else (guards, permissions, concurrency) is
central. `secrets: inherit` passes the org secrets through.

**2. Create the `auto-doc` label.** Required — the integrator passes
`--label auto-doc` and every guard checks it, so a missing label fails the run.

```sh
gh label create auto-doc --color C5DEF5 \
  --description "auto-doc PR; the auto-doc bot ignores it"
```

**3. Check repo Actions settings.** Settings → Actions → General:

- Workflow permissions: **Read and write**
- **Allow GitHub Actions to create and approve pull requests**: on

## Secrets and variables

Set these at the org level so new repos need nothing but the two workflow files.

| Name | Kind | Required | Purpose |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | secret | yes | Haiku classification calls in `extract.yml`. |
| `CLAUDE_CODE_OAUTH_TOKEN` | secret | yes | `claude-code-action` in `integrate.yml`. |
| `AUTO_DOC_APP_ID` | secret | no | GitHub App ID, for a dedicated bot identity. |
| `AUTO_DOC_APP_PRIVATE_KEY` | secret | no | GitHub App private key (PEM). |
| `AUTO_DOC_USE_APP` | variable | no | `'true'` to mint an App token instead of using `GITHUB_TOKEN`. |
| `AUTO_DOC_BASE_BRANCH` | variable | no | Branch doc PRs target. Defaults to the repo's default branch. |

Without a GitHub App the bot posts as `github-actions[bot]`, and **doc PRs it
opens won't trigger CI** — GitHub suppresses workflow events from
`GITHUB_TOKEN`-authored actions to prevent recursion. If a repo's doc PRs need
checks to run, use the App.

## Inputs

Both workflows take `auto-doc-ref` (default `v1`) — the ref of this repo whose
scripts get checked out. Keep it in sync with the ref you call at; only matters
if you pin a SHA instead of the floating `v1` tag.

`integrate.yml` also takes:

- `base-branch` — resolved as input → `vars.AUTO_DOC_BASE_BRANCH` → the repo's
  default branch. The `pull_request: closed` checkout sits on the merged feature
  branch, so the integrator always branches explicitly from this instead of HEAD.
- `doc-style-file` — house-style doc the integrator reads before editing
  anything (default `docs/writing-docs.md`). Silently skipped if absent, in
  which case the integrator infers style from the existing docs.

## Reviewer controls

| In a comment | Effect |
| --- | --- |
| `/document` | Force capture — treated as high-confidence even if the classifier would have passed. |
| `/document <text>` | Capture `<text>` verbatim as the rule; the classifier only picks the scope. |
| `/dontdocument` | Suppress. Deletes any existing bot reply, and never calls the model. |

Editing a comment reclassifies it. If the existing bot reply already has a 👍 or
👎, it's left alone and a new superseding reply is posted — a reaction approved
a specific wording, so it never silently transfers to different text.

## Scope allowlist

The proposed scope comes from user-written comments, so the integrator resolves
it and writes only to `CLAUDE.md`, a nested `**/CLAUDE.md`, or `docs/**/*.md`.
Anything else — absolute paths, `..` traversal, shell text — is dropped and
noted in the doc PR body.

## Known limitations

- Only a review's **inline** comments are classified, not the review's top-level
  summary body. State rules inline or use `/document`.
- Repos using `AGENTS.md` instead of `CLAUDE.md` aren't supported yet — the
  allowlist and reply text both assume `CLAUDE.md`.

## Development

```sh
cd scripts && npm ci
```

`extract.js` is the entrypoint for all three extract triggers; it reads the
event from `GITHUB_EVENT_PATH`. `classify.js` holds the classifier prompt and
schema, `github-comments.js` the `gh` mechanics, `prompts.js` the integrator
prompt. Ported out of `momentumdash/extension`, where it ran as two repo-local
workflows.
