/* global process */
// Decides whether a scheduled cleanup can skip: it can when every commit that
// landed on the base branch since the last successful cleanup came from a
// cleanup PR. Any error runs the cleanup instead. Runs in a checkout of the
// base branch (HEAD = base tip); writes skip=true|false to $GITHUB_OUTPUT and the reason to the step summary.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

// The base commit the last successful cleanup reviewed. cleanup.yml writes it
// after the agent succeeds, so failed runs and runs that opened no PR are
// accounted for without asking the Actions API.
export const LAST_REVIEWED_REF = 'refs/auto-doc/cleanup'

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf-8' }).trim()

// Integrator PRs (auto-doc/pr-N) add rules no cleanup has tidied yet, so only
// cleanup PRs count as noise. Matches the branch name in prompts.js.
const CLEANUP_BRANCH_PREFIX = 'auto-doc/cleanup-'

// Shape: the `{head_ref, user: {type}, labels: [name]}` projection both gh
// lookups use. cleanup-supersede.js closes only PRs this matches.
export const isCleanupPr = pr =>
	pr.user.type === 'Bot' && pr.labels.includes('auto-doc') && pr.head_ref.startsWith(CLEANUP_BRANCH_PREFIX)

// The PR whose merge produced this commit, not any PR whose branch merely
// contains it: GitHub also lists every open PR branched after the commit.
// ponytail: a rebase-merged cleanup PR only matches its last commit, so the
// earlier ones read as changes and the cleanup runs; that errs toward running.
const isCleanupMerge = (pr, sha) => pr.merge_commit_sha === sha && isCleanupPr(pr)

export function firstChangedCommit(commits, prsFor) {
	return commits.find(sha => !prsFor(sha).some(pr => isCleanupMerge(pr, sha))) ?? null
}

function prsFor(sha) {
	const out = run('gh', [
		'api',
		'--paginate',
		`repos/${process.env.GITHUB_REPOSITORY}/commits/${sha}/pulls`,
		'--jq',
		'.[] | {merge_commit_sha, head_ref: .head.ref, user: {type: .user.type}, labels: [.labels[].name]}',
	])
	return out ? out.split('\n').map(line => JSON.parse(line)) : []
}

function decide() {
	const base = process.env.BASE_BRANCH
	const head = run('git', ['rev-parse', 'HEAD'])
	const last = run('git', ['ls-remote', 'origin', LAST_REVIEWED_REF]).split(/\s/)[0]
	if (!last) return { skip: false, reason: `no earlier cleanup recorded at \`${LAST_REVIEWED_REF}\`` }
	try {
		run('git', ['merge-base', '--is-ancestor', last, head])
	} catch {
		return { skip: false, reason: `last reviewed commit \`${last}\` is not in \`${base}\`'s history (rewritten?)` }
	}
	const commits = run('git', ['rev-list', '--first-parent', `${last}..${head}`]).split('\n').filter(Boolean)
	const changed = firstChangedCommit(commits, prsFor)
	return changed
		? { skip: false, reason: `\`${changed}\` landed on \`${base}\` since the last cleanup reviewed \`${last}\`` }
		: { skip: true, reason: `nothing but cleanup PRs landed on \`${base}\` since the last cleanup reviewed \`${last}\`` }
}

if (import.meta.filename === process.argv[1]) {
	let decision
	try {
		decision = decide()
	} catch (error) {
		decision = { skip: false, error: true, reason: `gate error: ${error.message.split('\n')[0]}` }
	}
	const { skip, reason } = decision
	const line = `${skip ? 'Skipping' : 'Running'} cleanup: ${reason}.`
	console.log(decision.error ? `::warning::${line}` : line)
	fs.appendFileSync(process.env.GITHUB_OUTPUT, `skip=${skip}\n`)
	fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`)
}
