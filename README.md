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

> [!WARNING]
> **Private repositories only.** The integrator is an agent holding a
> write-scoped token, and its path allowlist is enforced by its prompt rather
> than mechanically. On a private repo an attacker needs write access to leave
> a comment in the first place, so injection grants them nothing new. On a
> public repo anyone can open a PR and comment. See
> [Security model](#security-model) before adopting this anywhere public.

### The `auto-doc` label

The integrator stamps every doc PR it opens with an `auto-doc` label, creating
the label first if the repo doesn't have one. Nobody applies it by hand.

It's how the bot recognizes its own PRs and skips them. Without it, a review
comment on a doc PR gets classified as a rule, approved, merged, and opens
another doc PR — indefinitely. Both job `if:` blocks and `hasAutoDocLabel()` in
`extract.js` check for it.

Why a label and not "was this PR opened by the bot"? Because the bot's identity
changes with configuration — `github-actions[bot]` normally, `<app-slug>[bot]`
once a GitHub App is configured, and the slug differs per install. The label
doesn't depend on any of that. The `auto-doc/*` branch name doesn't work either:
the `issue_comment` payload carries `issue.labels` but no head ref.

Under `GITHUB_TOKEN` the loop is suppressed anyway — GitHub doesn't raise
workflow events for its own actions. A GitHub App removes that suppression,
which is the point (doc PRs get CI), and leaves this label as the only thing
closing the loop.

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
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      AUTO_DOC_APP_ID: ${{ secrets.AUTO_DOC_APP_ID }}
      AUTO_DOC_APP_PRIVATE_KEY: ${{ secrets.AUTO_DOC_APP_PRIVATE_KEY }}
```

```yaml
# .github/workflows/auto-doc-integrate.yml
name: Auto-doc integrate
on:
  pull_request: { types: [closed] }
jobs:
  integrate:
    uses: momentumdash/auto-doc/.github/workflows/integrate.yml@v1
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      AUTO_DOC_APP_ID: ${{ secrets.AUTO_DOC_APP_ID }}
      AUTO_DOC_APP_PRIVATE_KEY: ${{ secrets.AUTO_DOC_APP_PRIVATE_KEY }}
```

Triggers have to live in the calling repo — GitHub doesn't let a reusable
workflow declare its own. Everything else (guards, permissions, concurrency) is
central. Name the secrets rather than using `secrets: inherit`, which would pass
the calling repo's *entire* secret set — see [Security model](#security-model).

**2. Check repo Actions settings.** Settings → Actions → General:

- Workflow permissions: **Read and write**
- **Allow GitHub Actions to create and approve pull requests**: on

Both only govern `GITHUB_TOKEN`. With a GitHub App configured they don't apply
to auto-doc, though other workflows in the repo may still need them.

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

### GitHub App setup

Create it at **Organization settings → Developer settings → GitHub Apps → New**:

- **Webhook**: uncheck Active. The App is only an identity; nothing calls it.
- **Repository permissions**:
  - Contents: **Read and write** — pushing the doc branch
  - Pull requests: **Read and write** — bot replies, PR creation, labels, reviewers
  - Issues: **Read and write** — top-level PR comments go through the issues API
  - Metadata: Read (mandatory, auto-selected)
- **Install it on All repositories.** With a selected-repositories install plus
  an org-level `AUTO_DOC_USE_APP`, any repo outside the selection fails at the
  token-minting step. Scope with the variable instead of the installation: set
  `AUTO_DOC_USE_APP` per repo if you don't want it everywhere.

Then App ID → `AUTO_DOC_APP_ID`, generated private key (PEM, whole file) →
`AUTO_DOC_APP_PRIVATE_KEY`, and `AUTO_DOC_USE_APP` → `true`.

The workflows scope each minted token down to the calling repo, so the token in
any given run can't reach the rest of the org. Installation tokens also get
5,000 requests/hour against `GITHUB_TOKEN`'s 1,000, which matters on PRs with
many review comments.

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
it and is instructed to write only to `CLAUDE.md`, a nested `**/CLAUDE.md`, or a
`docs/**/*.md` guide. Anything else — absolute paths, `..` traversal, shell text
— is dropped and noted in the doc PR body. This allowlist lives in the prompt,
not in code; see [Security model](#security-model) for what that does and
doesn't guarantee.

## Security model

**Never use `secrets: inherit` to call these.** Inherit passes the caller's
*entire* secret set, not just the secrets the called workflow declares. This
workflow is defined in a public repo behind a movable `v1` tag, so anyone who
can push here could repoint the tag and receive every secret the calling repo
holds — release signing keys, store credentials, deploy tokens. The examples
name the three secrets explicitly; keep it that way.

**Protect the `v1` tag, or pin callers to a SHA.** `AUTO_DOC_APP_PRIVATE_KEY`
is an org-wide credential, so whatever `v1` resolves to at run time is trusted
with it. A tag ruleset that blocks non-admin updates to `v1` restores roughly
the protection the code had when it lived inside a branch-protected repo.

**The extractor never checks out the calling repo.** It only talks to the API,
so no code from a PR under review is executed. The integrator does check out —
but only after merge, so that code is already reviewed.

**The human 👍 is the real gate**, and it's a gate on *rendered* text. That's
why `buildReplyBody` strips HTML comments and collapses whitespace: GitHub
renders `<!-- … -->` invisibly, so an unsanitized rule could show a reviewer
something benign while the integrator reads something else. `scripts/test.js`
covers this.

**The integrator's path allowlist is prompt-enforced, not mechanical.** It runs
with `Bash(gh:*)`, `Bash(git:*)` and a write-scoped token, so a sufficiently
good injection that survives both the classifier's JSON schema and a human 👍
could in principle reach writes outside `CLAUDE.md` / `docs/**`. For private
repos this grants an attacker nothing they didn't already have — they needed
write access to comment in the first place. **Don't run this on a public repo**
without narrowing `claude_args` first; there, anyone can open a PR and comment.

## Known limitations

- Only a review's **inline** comments are classified, not the review's top-level
  summary body. State rules inline or use `/document`.
- Repos using `AGENTS.md` instead of `CLAUDE.md` aren't supported yet — the
  allowlist and reply text both assume `CLAUDE.md`.

## Releasing

Callers reference the floating `v1` tag, and a ruleset on `refs/tags/v*` blocks
updates, deletions and force pushes with **no bypass actors** — deliberately, so
that whatever `v1` resolves to at run time can't be repointed by anyone with
push access. `v1` is what receives `AUTO_DOC_APP_PRIVATE_KEY`, an org-wide
credential.

That means moving `v1` is a deliberate act, not a `git push -f`:

1. Merge the change to `main`.
2. Settings → Rules → `protect release tags` → set enforcement to **Disabled**.
3. `git tag -f v1 && git push -f origin v1`
4. Set enforcement back to **Active**, and confirm:
   `gh api repos/momentumdash/auto-doc/rulesets --jq '.[] | "\(.name) \(.enforcement)"'`

Adding a repository-admin bypass would remove those two clicks, at the cost of
making the protection standing-optional rather than default-on. Not worth it —
step 3 happens rarely, and the window in step 2 is short and chosen.

Docs-only changes don't need any of this: the README isn't read at run time.

## Development

```sh
cd scripts && npm ci
```

`extract.js` is the entrypoint for all three extract triggers; it reads the
event from `GITHUB_EVENT_PATH`. `classify.js` holds the classifier prompt and
schema, `github-comments.js` the `gh` mechanics, `prompts.js` the integrator
prompt. Ported out of `momentumdash/extension`, where it ran as two repo-local
workflows.
