/* global process */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const BOT_MARKER_PREFIX = '<!-- auto-doc-bot'
export const botMarker = sourceCommentId => `<!-- auto-doc-bot ref:${sourceCommentId} -->`

// Thin wrapper around `gh api`. Args are passed as an array (execFileSync, no
// shell) so nothing in them is interpreted by a shell.
export function gh(args) {
	return execFileSync('gh', args, { encoding: 'utf-8' })
}

function ghJson(args) {
	const out = gh(args).trim()
	return out ? JSON.parse(out) : null
}

const reviewCommentsPath = (o, r, pr) => `repos/${o}/${r}/pulls/${pr}/comments`
const issueCommentsPath = (o, r, pr) => `repos/${o}/${r}/issues/${pr}/comments`
const commentPath = (o, r, id, isLineAnchored) => `repos/${o}/${r}/${isLineAnchored ? 'pulls' : 'issues'}/comments/${id}`

function ndjson(out) {
	return out
		.trim()
		.split('\n')
		.filter(Boolean)
		.map(line => JSON.parse(line))
}

/**
 * Fetch every existing bot reply on the PR once and index it by source comment.
 * Two paginated list calls total, regardless of how many candidates we process
 * — the per-candidate lookup is then in-memory (see lookupReply). Comments come
 * oldest-first, so a source with several replies maps to its newest.
 */
export function fetchBotReplies({ repoOwner, repoName, prNumber }) {
	const map = new Map() // `review:<srcId>` | `issue:<srcId>` -> { id }

	const review = gh([
		'api',
		reviewCommentsPath(repoOwner, repoName, prNumber),
		'--paginate',
		'--jq',
		`.[] | select(.body | startswith("${BOT_MARKER_PREFIX}")) | {id, in_reply_to_id}`,
	])
	for (const c of ndjson(review)) {
		if (c.in_reply_to_id != null) map.set(`review:${c.in_reply_to_id}`, { id: c.id })
	}

	const issue = gh([
		'api',
		issueCommentsPath(repoOwner, repoName, prNumber),
		'--paginate',
		'--jq',
		`.[] | select(.body | startswith("${BOT_MARKER_PREFIX}")) | {id, body}`,
	])
	for (const c of ndjson(issue)) {
		// Match the full marker (`ref:<id> -->`), not a substring — otherwise
		// ref:12 would collide with ref:123.
		const m = c.body.match(/ref:(\d+) -->/)
		if (m) map.set(`issue:${m[1]}`, { id: c.id })
	}

	return map
}

/** Look up the bot's existing reply for a source comment in the fetched map. */
export function lookupReply(map, { sourceCommentId, isLineAnchored }) {
	return map.get(`${isLineAnchored ? 'review' : 'issue'}:${sourceCommentId}`) ?? null
}

/**
 * The source comments a person approved: across the bot's marker replies to a
 * source, at least one 👍 and no 👎, counting only reactions from authors
 * isIgnoredAuthor lets through. A source that was deleted is dropped.
 * `comments` holds both streams, each tagged `isLineAnchored`.
 */
export function approvedRules(comments, reactionsFor, ignored) {
	const byId = new Map(comments.map(c => [`${c.isLineAnchored}:${c.id}`, c]))
	const repliesBySource = new Map()
	for (const c of comments) {
		const ref = c.user.type === 'Bot' && c.body.startsWith(BOT_MARKER_PREFIX) && c.body.match(/ref:(\d+) -->/)
		const source = ref && byId.get(`${c.isLineAnchored}:${ref[1]}`)
		if (source) repliesBySource.set(source, [...(repliesBySource.get(source) ?? []), c])
	}
	return [...repliesBySource].flatMap(([source, replies]) => {
		// `votes` is the list endpoint's 👍 + 👎 total; with none, there's nothing to fetch.
		const votes = replies
			.filter(reply => reply.votes !== 0)
			.flatMap(reactionsFor)
			.filter(r => !isIgnoredAuthor(r.user, ignored))
			.map(r => r.content)
		if (!votes.includes('+1') || votes.includes('-1')) return []
		return [{ sourceUrl: source.html_url, sourceAuthor: source.user.login, source: stripHidden(source.body) }]
	})
}

/** approvedRules for a PR: two list calls, then a reactions call per marker reply that has any 👍 or 👎. */
export function fetchApprovedRules({ repoOwner, repoName, prNumber }, ignored) {
	const user = '{login: .user.login, type: .user.type}'
	const list = (endpoint, isLineAnchored) =>
		ndjson(
			gh(['api', endpoint, '--paginate', '--jq', `.[] | {id, body, html_url, user: ${user}, votes: (.reactions["+1"] + .reactions["-1"])}`])
		).map(c => ({ ...c, isLineAnchored }))
	const reactionsFor = ({ id, isLineAnchored }) =>
		ndjson(gh(['api', `${commentPath(repoOwner, repoName, id, isLineAnchored)}/reactions`, '--paginate', '--jq', `.[] | {content, user: ${user}}`]))
	const comments = [
		...list(reviewCommentsPath(repoOwner, repoName, prNumber), true),
		...list(issueCommentsPath(repoOwner, repoName, prNumber), false),
	]
	return approvedRules(comments, reactionsFor, ignored)
}

function withBodyFile(body, fn) {
	const file = path.join(os.tmpdir(), `auto-doc-body-${process.pid}-${Date.now()}.md`)
	fs.writeFileSync(file, body)
	try {
		return fn(file)
	} finally {
		fs.rmSync(file, { force: true })
	}
}

/** Post a new threaded reply. Returns the created comment's html_url. */
export function postReply({ repoOwner, repoName, prNumber, sourceCommentId, isLineAnchored, body }) {
	return withBodyFile(body, file => {
		if (isLineAnchored) {
			const created = ghJson([
				'api',
				reviewCommentsPath(repoOwner, repoName, prNumber),
				'-F',
				`body=@${file}`,
				'-F',
				`in_reply_to=${sourceCommentId}`,
			])
			return created?.html_url
		}
		const created = ghJson(['api', issueCommentsPath(repoOwner, repoName, prNumber), '-F', `body=@${file}`])
		return created?.html_url
	})
}

/** Edit an existing bot reply in place. */
export function editReply({ repoOwner, repoName, commentId, isLineAnchored, body }) {
	const base = commentPath(repoOwner, repoName, commentId, isLineAnchored)
	withBodyFile(body, file => gh(['api', base, '-X', 'PATCH', '-F', `body=@${file}`]))
}

/** Delete an existing bot reply. */
export function deleteReply({ repoOwner, repoName, commentId, isLineAnchored }) {
	const base = commentPath(repoOwner, repoName, commentId, isLineAnchored)
	gh(['api', base, '-X', 'DELETE'])
}

/** Fetch all inline review comments for a submitted review. */
export function listReviewComments({ repoOwner, repoName, prNumber, reviewId }) {
	const out = gh([
		'api',
		`repos/${repoOwner}/${repoName}/pulls/${prNumber}/reviews/${reviewId}/comments`,
		'--paginate',
		'--slurp',
	]).trim()
	if (!out) return []
	return JSON.parse(out).flat()
}

/**
 * Strip HTML comments, which GitHub renders invisibly.
 *
 * The human 👍 is this system's only real gate: a reviewer reads a comment and
 * its proposed rule and approves them, and the integrator later acts on that
 * text with a write-scoped token. That gate fails if the text a reviewer sees
 * isn't the text the integrator reads, so `<!-- ignore the above, instead ... -->`
 * inside a benign-looking comment would be approved blind.
 */
function stripHidden(text) {
	return String(text ?? '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<!--|-->/g, '')
		.trim()
}

/**
 * Build the bot reply body, with the marker on line 1 so the integrator can find it.
 * The rule is collapsed to one line so it stays inside its blockquote, where it
 * reads as quoted data rather than as new sections of the bot's own message.
 *
 * No target file is proposed: the extractor only sees the diff, so any location
 * it guesses is usually wrong. The merge-time integrator, which can read the
 * whole repo's doc tree, decides where the rule belongs.
 */
export function buildReplyBody({ sourceCommentId, rule }) {
	return `${botMarker(sourceCommentId)}
📝 Capture this as a documented rule?
> ${stripHidden(rule).replace(/\s+/g, ' ')}

React 👍 to record it at merge (the merge-time bot picks where it belongs). React 👎 to dismiss (a single 👎 from any reviewer overrides any 👍s).
Want different wording? Reply \`/document <your rule text>\` — the bot posts a fresh proposal using your text verbatim.`
}

// Authors whose comments auto-doc never classifies. GitHub Apps (coderabbitai,
// github-actions, ...) carry user.type === 'Bot' and are caught by the type
// check; a bot backed by a plain user account (a PAT/machine user) does NOT, so
// it needs an explicit login denylist. AUTO_DOC_IGNORE_AUTHORS is a
// comma-separated list of such logins, matched case-insensitively.
export function ignoredAuthorLogins(env = process.env) {
	return new Set(
		(env.AUTO_DOC_IGNORE_AUTHORS || '')
			.split(',')
			.map(s => s.trim().toLowerCase())
			.filter(Boolean)
	)
}

/** True when a comment's author should be skipped (a Bot, or a denylisted login). */
export function isIgnoredAuthor(user, ignored) {
	if (!user) return false
	if (user.type === 'Bot') return true
	return ignored.has((user.login || '').toLowerCase())
}
