/* global process */
// Replaces last week's open cleanup PR with this run's, so review feedback never
// lands on a PR that conflicts with the base or still runs a stale auto-doc pin.
//   find   before the agent: writes numbers=<open cleanup PRs> to $GITHUB_OUTPUT
//   close  after it, PREVIOUS=<those numbers>: closes each in favour of the new PR
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { isCleanupPr } from './cleanup-gate.js'

// A merge commit only syncs the base in (someone working around a stale PR),
// so it carries no edit the new PR would lose. A commit with no linked account
// has no author type and counts as a person's.
const isHumanCommit = c => c.parents < 2 && c.author !== 'Bot'

/**
 * Closes every PR in `previous` in favour of the newest cleanup PR opened since,
 * and notes the outcome in that PR's body. Returns the PRs it couldn't close.
 */
export function supersede(previous, api) {
	if (!previous.length) return []
	const newPr = api
		.openCleanupPrs()
		.filter(n => n > Math.max(...previous))
		.at(-1)
	// The agent opened nothing, so the earlier PR is still the live proposal.
	if (!newPr) return []

	const closed = []
	const notes = []
	const failed = []
	for (const n of previous) {
		if (!api.isOpen(n)) continue
		if (api.commits(n).some(isHumanCommit)) {
			notes.push(`#${n} stays open because it has commits from a person. Reconcile it with this PR by hand.`)
			continue
		}
		try {
			api.close(n, `Superseded by #${newPr}, which re-runs the cleanup against the current base branch and carries this PR's open feedback forward.`)
			closed.push(n)
		} catch (error) {
			// Merged or closed since the check above: nothing left to supersede.
			if (!api.isOpen(n)) continue
			failed.push(n)
			notes.push(`Could not close #${n} (${error.message.split('\n')[0]}). Close it by hand.`)
		}
	}
	if (closed.length) notes.unshift(`Supersedes ${closed.map(n => `#${n}`).join(', ')}.`)
	if (notes.length) api.appendBody(newPr, notes.join('\n\n'))
	return failed
}

function ghApi() {
	const repo = process.env.GITHUB_REPOSITORY
	const gh = args => execFileSync('gh', args, { encoding: 'utf-8' }).trim()
	const ndjson = out => (out ? out.split('\n').map(line => JSON.parse(line)) : [])
	return {
		openCleanupPrs: () =>
			ndjson(
				gh([
					'api',
					'--paginate',
					`repos/${repo}/pulls?state=open&base=${encodeURIComponent(process.env.BASE_BRANCH)}&per_page=100`,
					'--jq',
					'.[] | {number, head_ref: .head.ref, user: {type: .user.type}, labels: [.labels[].name]}',
				])
			)
				.filter(isCleanupPr)
				.map(pr => pr.number)
				.sort((a, b) => a - b),
		isOpen: n => gh(['api', `repos/${repo}/pulls/${n}`, '--jq', '.state']) === 'open',
		commits: n =>
			ndjson(
				gh([
					'api',
					'--paginate',
					`repos/${repo}/pulls/${n}/commits`,
					'--jq',
					'.[] | {parents: (.parents | length), author: .author.type}',
				])
			),
		close: (n, comment) => gh(['pr', 'close', `${n}`, '--repo', repo, '--comment', comment]),
		appendBody: (n, text) => {
			const body = gh(['api', `repos/${repo}/pulls/${n}`, '--jq', '.body // ""'])
			gh(['api', '-X', 'PATCH', `repos/${repo}/pulls/${n}`, '-f', `body=${body}\n\n${text}`])
		},
	}
}

if (import.meta.filename === process.argv[1]) {
	const api = ghApi()
	if (process.argv[2] === 'find') {
		let numbers = []
		try {
			numbers = api.openCleanupPrs()
		} catch (error) {
			// Errs toward running the cleanup: the old PR just stays open, as before.
			console.log(`::warning::Could not list open cleanup PRs: ${error.message.split('\n')[0]}`)
		}
		console.log(numbers.length ? `Open cleanup PRs to supersede: ${numbers.join(', ')}` : 'No open cleanup PR to supersede.')
		fs.appendFileSync(process.env.GITHUB_OUTPUT, `numbers=${numbers.join(' ')}\n`)
	} else if (process.argv[2] === 'close') {
		const previous = (process.env.PREVIOUS || '').split(' ').filter(Boolean).map(Number)
		const failed = supersede(previous, api)
		for (const n of failed) console.log(`::error::Could not close superseded cleanup PR #${n}`)
		if (failed.length) process.exit(1)
	} else {
		console.error(`cleanup-supersede: expected 'find' or 'close', got: ${process.argv[2]}`)
		process.exit(1)
	}
}
