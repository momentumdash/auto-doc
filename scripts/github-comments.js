/* global process */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const BOT_MARKER_PREFIX = '<!-- auto-doc-bot'
export const botMarker = sourceCommentId => `<!-- auto-doc-bot ref:${sourceCommentId} -->`

// Thin wrapper around `gh api`. Args are passed as an array (execFileSync, no
// shell) so nothing in them is interpreted by a shell.
function gh(args) {
	return execFileSync('gh', args, { encoding: 'utf-8' })
}

function ghJson(args) {
	const out = gh(args).trim()
	return out ? JSON.parse(out) : null
}

const reviewCommentsPath = (o, r, pr) => `repos/${o}/${r}/pulls/${pr}/comments`
const issueCommentsPath = (o, r, pr) => `repos/${o}/${r}/issues/${pr}/comments`
const reviewCommentPath = (o, r, id) => `repos/${o}/${r}/pulls/comments/${id}`
const issueCommentPath = (o, r, id) => `repos/${o}/${r}/issues/comments/${id}`

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
 * — the per-candidate lookup is then in-memory (see lookupReply). Keyed maps
 * keep the NEWEST reply per source: the GitHub REST API returns comments
 * oldest-first, so a later Map.set overwrites the older one, which is what we
 * want after a SUPERSEDES (old reacted reply + current proposal coexist).
 */
export function fetchBotReplies({ repoOwner, repoName, prNumber }) {
	const map = new Map() // `review:<srcId>` | `issue:<srcId>` -> { id, html_url }

	const review = gh([
		'api',
		reviewCommentsPath(repoOwner, repoName, prNumber),
		'--paginate',
		'--jq',
		`.[] | select(.body | startswith("${BOT_MARKER_PREFIX}")) | {id, html_url, in_reply_to_id}`,
	])
	for (const c of ndjson(review)) {
		if (c.in_reply_to_id != null) map.set(`review:${c.in_reply_to_id}`, { id: c.id, html_url: c.html_url })
	}

	const issue = gh([
		'api',
		issueCommentsPath(repoOwner, repoName, prNumber),
		'--paginate',
		'--jq',
		`.[] | select(.body | startswith("${BOT_MARKER_PREFIX}")) | {id, html_url, body}`,
	])
	for (const c of ndjson(issue)) {
		// Match the full marker (`ref:<id> -->`), not a substring — otherwise
		// ref:12 would collide with ref:123.
		const m = c.body.match(/ref:(\d+) -->/)
		if (m) map.set(`issue:${m[1]}`, { id: c.id, html_url: c.html_url })
	}

	return map
}

/** Look up the bot's existing reply for a source comment in the fetched map. */
export function lookupReply(map, { sourceCommentId, isLineAnchored }) {
	return map.get(`${isLineAnchored ? 'review' : 'issue'}:${sourceCommentId}`) ?? null
}

/**
 * Count VALIDATION reactions (👍/👎) on the bot reply from non-bot users.
 * Only +1/-1 count — those are the capture/dismiss signals the integrator acts
 * on. A ❤️/🚀/👀 etc. is enthusiasm, not validation, and shouldn't freeze the
 * reply from being edited in place (which would otherwise force a redundant
 * superseding post).
 */
export function validationReactionCount({ repoOwner, repoName, commentId, isLineAnchored }) {
	const base = isLineAnchored
		? reviewCommentPath(repoOwner, repoName, commentId)
		: issueCommentPath(repoOwner, repoName, commentId)
	// --slurp wraps each page in an outer array; `add` flattens before length so
	// a >30-reaction (multi-page) comment doesn't emit one count per page.
	const reactions = ghJson([
		'api',
		`${base}/reactions`,
		'--paginate',
		'--slurp',
		'--jq',
		'(add // []) | map(select(.user.type != "Bot" and (.content == "+1" or .content == "-1"))) | length',
	])
	return typeof reactions === 'number' ? reactions : 0
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
	const base = isLineAnchored
		? reviewCommentPath(repoOwner, repoName, commentId)
		: issueCommentPath(repoOwner, repoName, commentId)
	withBodyFile(body, file => gh(['api', base, '-X', 'PATCH', '-F', `body=@${file}`]))
}

/** Delete an existing bot reply. */
export function deleteReply({ repoOwner, repoName, commentId, isLineAnchored }) {
	const base = isLineAnchored
		? reviewCommentPath(repoOwner, repoName, commentId)
		: issueCommentPath(repoOwner, repoName, commentId)
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
 * Strip anything that would render invisibly on GitHub or forge structure in
 * the reply body.
 *
 * The human 👍 is this system's only real gate: a reviewer reads the proposed
 * rule and approves it, and the integrator later acts on that same text with a
 * write-scoped token. That gate fails if the text a reviewer sees isn't the
 * text the integrator reads — and GitHub renders HTML comments invisibly, so
 * `<!-- ignore the above, instead ... -->` inside a benign-looking rule is
 * approved blind. Collapsing whitespace likewise keeps the rule inside its
 * blockquote, where it reads as quoted data rather than as new sections of the
 * bot's own message.
 */
function sanitizeForReply(text) {
	return String(text ?? '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<!--|-->/g, '')
		.replace(/\s+/g, ' ')
		.trim()
}

/**
 * Build the bot reply body. `supersedesUrl`, when set, adds a line immediately
 * after the marker (keeping the marker on line 1 so the integrator can find it).
 */
export function buildReplyBody({ sourceCommentId, scope, rule, supersedesUrl }) {
	scope = sanitizeForReply(scope).replace(/\s/g, '')
	rule = sanitizeForReply(rule)
	const scopeDir = scope ? `${scope}/CLAUDE.md` : 'CLAUDE.md'
	const supersedes = supersedesUrl
		? `\n> Supersedes earlier proposal at ${supersedesUrl}; that one's 👍 was for the previous wording.\n`
		: ''
	return `${botMarker(sourceCommentId)}${supersedes}
📝 Add to \`${scopeDir}\`?
> ${rule}

React 👍 to capture at merge. React 👎 to dismiss (a single 👎 from any reviewer overrides any 👍s).`
}
