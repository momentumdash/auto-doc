/* global process */
// Replaces last week's open cleanup PR with this run's, so review feedback never
// lands on a PR that conflicts with the base or still runs a stale auto-doc pin.
//   find   before the agent: writes numbers=<open cleanup PRs> and since=<now>
//          to $GITHUB_OUTPUT
//   close  after it, PREVIOUS=<numbers> SINCE=<since>: closes each in favour of
//          the new PR
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { isCleanupPr } from './cleanup-gate.js'
import { ignoredAuthorLogins, isIgnoredAuthor } from './github-comments.js'

// A merge commit only syncs the base in (someone working around a stale PR),
// so it carries no edit the new PR would lose. ponytail: a person's edits inside
// a merge's conflict resolution go undetected; diff the merge against its
// parents if that ever bites. A commit with no linked account counts as a person's.
const isHumanCommit = c => c.parents < 2 && c.author !== 'Bot'

// The same people whose feedback the cleanup agent reads (prompts.js).
const WRITE_ACCESS = ['OWNER', 'MEMBER', 'COLLABORATOR']

/**
 * Closes every PR in `previous` in favour of the newest cleanup PR opened since,
 * and notes the outcome in that PR's body. `since` is when this run started;
 * `ignored` is the AUTO_DOC_IGNORE_AUTHORS set. Returns workflow annotations
 * for the step log.
 */
export function supersede({ previous, since, ignored }, api) {
	const list = previous.map(n => `#${n}`).join(', ')
	const sinceMs = Date.parse(since)
	if (Number.isNaN(sinceMs)) return [`::error::SINCE is not a timestamp (${since}), so ${list} stays open.`]
	const isLateFeedback = f =>
		Date.parse(f.at) > sinceMs && WRITE_ACCESS.includes(f.assoc) && !isIgnoredAuthor({ type: f.type, login: f.login }, ignored)

	const newPr = api
		.openCleanupPrs()
		.filter(n => n > Math.max(...previous))
		.at(-1)
	if (!newPr) return [`::warning::No new cleanup PR found, so ${list} stays open.`]

	const closed = []
	const notes = []
	const annotations = []
	for (const n of previous) {
		try {
			if (!api.isOpen(n)) continue
			if (api.commits(n).some(isHumanCommit)) {
				notes.push(`#${n} stays open because it has commits from a person. Reconcile it with this PR by hand.`)
			} else if (api.feedback(n).some(isLateFeedback)) {
				notes.push(`#${n} stays open because it got review feedback after this run started. Carry that over by hand.`)
			} else {
				api.close(n, `Superseded by #${newPr}, which re-runs the cleanup against the current base branch and carries this PR's open feedback forward. Feedback left here from now on won't be read.`)
				closed.push(n)
			}
		} catch (error) {
			notes.push(`Could not close #${n} (${error.message.split('\n')[0]}). Close it by hand.`)
			annotations.push(`::error::Could not close superseded cleanup PR #${n}`)
		}
	}
	if (closed.length) notes.unshift(`Supersedes ${closed.map(n => `#${n}`).join(', ')}.`)
	try {
		if (notes.length) api.appendBody(newPr, notes.join('\n\n'))
	} catch (error) {
		annotations.push(`::error::Could not note this on #${newPr}: ${notes.join(' ')} (${error.message.split('\n')[0]})`)
	}
	return annotations
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
		// Comments and submitted reviews as {at, login, type, assoc}. Inline
		// comments and replies each arrive as a review, so two connections cover
		// it all. A review's createdAt is when it was started, possibly hours
		// before it was submitted.
		feedback: n =>
			ndjson(
				gh([
					'api',
					'graphql',
					'-f',
					'query=query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$number){ comments(last:50){ nodes{ createdAt authorAssociation author{ __typename login } } } reviews(last:50){ nodes{ submittedAt authorAssociation author{ __typename login } } } } } }',
					'-f',
					`owner=${repo.split('/')[0]}`,
					'-f',
					`name=${repo.split('/')[1]}`,
					'-F',
					`number=${n}`,
					'--jq',
					'.data.repository.pullRequest | (.comments.nodes[] | .at = .createdAt), (.reviews.nodes[] | .at = .submittedAt) | {at, login: .author.login, type: .author.__typename, assoc: .authorAssociation}',
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
		fs.appendFileSync(process.env.GITHUB_OUTPUT, `numbers=${numbers.join(' ')}\nsince=${new Date().toISOString()}\n`)
	} else if (process.argv[2] === 'close') {
		const previous = (process.env.PREVIOUS || '').split(' ').filter(Boolean).map(Number)
		const annotations = supersede({ previous, since: process.env.SINCE, ignored: ignoredAuthorLogins() }, api)
		for (const line of annotations) console.log(line)
		if (annotations.some(line => line.startsWith('::error::'))) process.exit(1)
	} else {
		console.error(`cleanup-supersede: expected 'find' or 'close', got: ${process.argv[2]}`)
		process.exit(1)
	}
}
