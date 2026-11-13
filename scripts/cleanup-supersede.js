/* global process */
// Replaces last week's open cleanup PR with this run's, so review feedback never
// lands on a PR that conflicts with the base or still runs a stale auto-doc pin.
//   find     before the agent: writes numbers=<open cleanup PRs>, since=<now>,
//            and feedback=<their review feedback as one-line JSON, for the
//            prompt> to $GITHUB_OUTPUT
//   verdict  after it, SINCE=<since> <execution_file>: writes pr=<the PR this
//            run opened>; fails on a denied call unless it is a benign shell
//            habit and the run opened a PR
//   close    then, PREVIOUS=<numbers> NEW_PR=<pr> SINCE=<since>: closes each in
//            favour of the new PR
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { escapeData, readDeniedCalls } from './agent-verdict.js'
import { isCleanupPr } from './cleanup-gate.js'
import { ignoredAuthorLogins, isIgnoredAuthor } from './github-comments.js'

// A merge commit only syncs the base in (someone working around a stale PR),
// so it carries no edit the new PR would lose. ponytail: a person's edits inside
// a merge's conflict resolution go undetected; diff the merge against its
// parents if that ever bites. A commit with no linked account counts as a person's.
const isHumanCommit = c => c.parents < 2 && c.author !== 'Bot'

// Feedback counts from people with write access, as respond.yml requires.
const WRITE_ACCESS = ['OWNER', 'MEMBER', 'COLLABORATOR']
const isPerson = (f, ignored) => WRITE_ACCESS.includes(f.assoc) && !isIgnoredAuthor(f, ignored)

// GraphQL names an app `name`, REST `name[bot]`.
const botName = login => login.replace(/\[bot\]$/, '')

// One env string tops out at 128 KiB on Linux, and the feedback travels in two
// (the step output, then the prompt), so stay well under it.
const BODY_LIMIT = 4000
const TOTAL_LIMIT = 80_000

/**
 * The part of one PR's `feedback` the agent reads: what people said, plus the
 * PR author's own replies, which show what was already applied. Drops empty
 * bodies and anyone else (a drive-by commenter, CodeRabbit), so outsider text
 * never reaches the prompt. Bodies are cut at BODY_LIMIT; once `budget.left` is
 * spent the rest is dropped. Either sets `budget.clipped`.
 */
export function promptFeedback({ comments, reviews, threads }, { ignored, author, budget }) {
	const clip = f => {
		if (budget.left <= 0) return (budget.clipped = true), null
		const body = f.body.length > BODY_LIMIT ? `${f.body.slice(0, BODY_LIMIT)}... [truncated]` : f.body
		if (body !== f.body) budget.clipped = true
		budget.left -= body.length
		return { ...f, body }
	}
	const keep = f => f.body && (f.type === 'Bot' ? botName(f.login) === botName(author) : isPerson(f, ignored))
	const take = items => items.filter(keep).map(clip).filter(Boolean)
	return {
		comments: take(comments),
		reviews: take(reviews),
		threads: threads.map(t => ({ ...t, comments: take(t.comments) })).filter(t => t.comments.length),
	}
}

// Denied Bash calls that only mean the agent reached for a shell habit the
// allow-list rejects: the first word of the command. Anything else (another
// tool, curl, an unknown command) may be a planted comment steering it. Matches
// the 200-char truncated line from agent-verdict.js.
// ponytail: only the first word is checked, so `ls; curl x` passes; split on
// ;|& if a steered run ever shows up that way.
const BENIGN_DENIAL = /^denied Bash: (cd|grep|ls|head|cat|sed|wc|sort|for|while)\b/

/**
 * Annotations for the denied calls. A benign denial only warns when the run
 * opened a PR (`newPr`): the old PRs' feedback is in the prompt, so it can't
 * have hidden it. Every other denial fails the run, PR or not.
 */
export function verdict(denied, newPr) {
	return denied.map(line => `::${newPr && BENIGN_DENIAL.test(line) ? 'warning' : 'error'}::${escapeData(line)}`)
}

const feedbackItems = ({ comments, reviews, threads }) => [...comments, ...reviews, ...threads.flatMap(t => t.comments)]

/**
 * Closes every PR in `previous` in favour of `newPr`, the one this run opened,
 * and notes the outcome in its body. `since` is when this run fetched their
 * feedback; `ignored` is the AUTO_DOC_IGNORE_AUTHORS set. Returns workflow
 * annotations for the step log.
 */
export function supersede({ previous, newPr, since, ignored }, api) {
	const list = previous.map(n => `#${n}`).join(', ')
	const sinceMs = Date.parse(since)
	if (Number.isNaN(sinceMs)) return [`::error::SINCE is not a timestamp (${since}), so ${list} stays open.`]
	const isLateFeedback = f => Date.parse(f.at) > sinceMs && isPerson(f, ignored)
	if (!newPr) return [`::warning::No new cleanup PR found, so ${list} stays open.`]

	const closed = []
	const notes = []
	const annotations = []
	for (const n of previous) {
		try {
			if (!api.isOpen(n)) continue
			if (api.commits(n).some(isHumanCommit)) {
				notes.push(`#${n} stays open because it has commits from a person. Reconcile it with this PR by hand.`)
			} else {
				const feedback = api.feedback(n)
				if (feedback.truncated) {
					notes.push(`#${n} stays open because it has more feedback than this run reads. Carry the rest over by hand.`)
				} else if (feedbackItems(feedback).some(isLateFeedback)) {
					notes.push(`#${n} stays open because it got review feedback after this run read it. Carry that over by hand.`)
				} else {
					api.close(n, `Superseded by #${newPr}, which re-runs the cleanup against the current base branch and carries this PR's open feedback forward. Feedback left here from now on won't be read.`)
					closed.push(n)
				}
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
					'.[] | {number, created_at, head_ref: .head.ref, user: {type: .user.type, login: .user.login}, labels: [.labels[].name]}',
				])
			)
				.filter(isCleanupPr)
				.sort((a, b) => a.number - b.number),
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
		// {comments, reviews, threads, truncated}, each item {at, login, type, assoc,
		// body}; truncated is true when a connection had more than the cap.
		// A review's createdAt is when it was started, possibly hours before it
		// was submitted. The newest feedback is the most likely unacted, so the
		// caps keep the last items.
		feedback: n =>
			JSON.parse(
				gh([
					'api',
					'graphql',
					'-f',
					'query=query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$number){ comments(last:100){ pageInfo{ hasPreviousPage } nodes{ createdAt authorAssociation author{ __typename login } body } } reviews(last:100){ pageInfo{ hasPreviousPage } nodes{ submittedAt authorAssociation author{ __typename login } state body } } reviewThreads(last:100){ pageInfo{ hasPreviousPage } nodes{ isResolved path line comments(last:50){ pageInfo{ hasPreviousPage } nodes{ createdAt authorAssociation author{ __typename login } body } } } } } } }',
					'-f',
					`owner=${repo.split('/')[0]}`,
					'-f',
					`name=${repo.split('/')[1]}`,
					'-F',
					`number=${n}`,
					'--jq',
					'.data.repository.pullRequest | def item: {at, login: .author.login, type: .author.__typename, assoc: .authorAssociation, body}; {comments: [.comments.nodes[] | .at = .createdAt | item], reviews: [.reviews.nodes[] | .at = .submittedAt | item + {state}], threads: [.reviewThreads.nodes[] | {isResolved, path, line, comments: [.comments.nodes[] | .at = .createdAt | item]}], truncated: ([.comments.pageInfo, .reviews.pageInfo, .reviewThreads.pageInfo, .reviewThreads.nodes[].comments.pageInfo] | any(.hasPreviousPage))}',
				])
			),
		close: (n, comment) => gh(['pr', 'close', `${n}`, '--repo', repo, '--comment', comment]),
		appendBody: (n, text) => {
			const body = gh(['api', `repos/${repo}/pulls/${n}`, '--jq', '.body // ""'])
			gh(['api', '-X', 'PATCH', `repos/${repo}/pulls/${n}`, '-f', `body=${body}\n\n${text}`])
		},
	}
}

// Real paths, as in agent-verdict.js: the verdict must never skip silently.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const api = ghApi()
	const since = process.env.SINCE
	if (process.argv[2] === 'find') {
		// Before the fetch, so feedback that lands during it counts as late.
		const started = new Date().toISOString()
		let feedback = {}
		const budget = { left: TOTAL_LIMIT }
		try {
			const ignored = ignoredAuthorLogins()
			feedback = Object.fromEntries(
				api.openCleanupPrs().map(({ number, user }) => [number, promptFeedback(api.feedback(number), { ignored, author: user.login, budget })])
			)
		} catch (error) {
			// Errs toward running the cleanup: the old PRs just stay open, as before.
			console.log(`::warning::Could not read open cleanup PRs: ${error.message.split('\n')[0]}`)
		}
		if (budget.clipped) console.log(`::warning::Some feedback on the open cleanup PRs was cut to fit the size limit (${BODY_LIMIT} characters per item, ${TOTAL_LIMIT} in all).`)
		const numbers = Object.keys(feedback)
		console.log(numbers.length ? `Open cleanup PRs to supersede: ${numbers.join(', ')}` : 'No open cleanup PR to supersede.')
		// One line of JSON: no comment text can end a GITHUB_OUTPUT entry.
		fs.appendFileSync(process.env.GITHUB_OUTPUT, `numbers=${numbers.join(' ')}\nsince=${started}\nfeedback=${JSON.stringify(feedback)}\n`)
	} else if (process.argv[2] === 'verdict') {
		const denied = readDeniedCalls(process.argv[3])
		let newPr
		try {
			newPr = api.openCleanupPrs().filter(pr => Date.parse(pr.created_at) >= Date.parse(since)).at(-1)?.number
		} catch (error) {
			// An unknown PR counts as none: a clean run goes on (the old PRs stay
			// open) and a denied one records nothing.
			console.log(`::warning::Could not look up this run's PR: ${error.message.split('\n')[0]}`)
		}
		const annotations = verdict(denied, newPr)
		console.log(newPr ? `This run opened #${newPr}.` : 'This run opened no cleanup PR.')
		for (const line of annotations) console.log(line)
		fs.appendFileSync(process.env.GITHUB_OUTPUT, `pr=${newPr ?? ''}\n`)
		if (annotations.some(line => line.startsWith('::error::'))) process.exit(1)
	} else if (process.argv[2] === 'close') {
		const previous = (process.env.PREVIOUS || '').split(' ').filter(Boolean).map(Number)
		const annotations = supersede({ previous, newPr: Number(process.env.NEW_PR) || undefined, since, ignored: ignoredAuthorLogins() }, api)
		for (const line of annotations) console.log(line)
		if (annotations.some(line => line.startsWith('::error::'))) process.exit(1)
	} else {
		console.error(`cleanup-supersede: expected 'find', 'verdict', or 'close', got: ${process.argv[2]}`)
		process.exit(1)
	}
}
