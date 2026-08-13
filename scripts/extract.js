/* global process */
import fs from 'node:fs'
import { classifyComment } from './classify.js'
import {
	buildReplyBody,
	deleteReply,
	editReply,
	fetchBotReplies,
	listReviewComments,
	lookupReply,
	postReply,
	validationReactionCount,
} from './github-comments.js'

const eventName = process.env.GITHUB_EVENT_NAME
const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf-8'))
const repoOwner = event.repository.owner.login
const repoName = event.repository.name

const hasAutoDocLabel = labels => Array.isArray(labels) && labels.some(l => l.name === 'auto-doc')

function parseMarkers(body) {
	if (/\/dontdocument\b/i.test(body)) return { suppress: true }
	const doc = body.match(/\/document\b[ \t]*(.*)/i)
	if (doc) return { manualMarker: true, providedRuleText: doc[1].trim() || null }
	return {}
}

async function processCandidate(cand, common, replies) {
	const markers = parseMarkers(cand.body)
	const target = { repoOwner, repoName, isLineAnchored: cand.isLineAnchored }
	const existing = lookupReply(replies, { sourceCommentId: cand.id, isLineAnchored: cand.isLineAnchored })

	// /dontdocument: delete a prior reply if present, never call the LLM.
	if (markers.suppress) {
		if (existing) {
			deleteReply({ ...target, commentId: existing.id })
			console.log(`auto-doc: deleted reply for ${cand.id} (/dontdocument)`)
		}
		return
	}

	let result = await classifyComment({
		body: cand.body,
		filePath: cand.filePath,
		line: cand.line,
		prTitle: common.prTitle,
		prNumber: common.prNumber,
		isLineAnchored: cand.isLineAnchored,
		sourceCommentId: cand.id,
		manualMarker: markers.manualMarker,
		providedRuleText: markers.providedRuleText,
	})

	// Explicit /document <text>: honor the reviewer's wording verbatim and force
	// capture, regardless of the model's verdict. Use the model's scope if we
	// got one, else repo root.
	if (markers.providedRuleText) {
		result = { isRule: true, scope: result?.scope ?? '', rule: markers.providedRuleText, why: '' }
	}

	// null = classification could not be completed (API error / refusal /
	// truncation / unparseable). Do NOT mutate — preserve any existing
	// human-validated reply rather than deleting it on a transient failure.
	if (!result) {
		console.error(`auto-doc: classification unavailable for ${cand.id}; leaving any existing reply untouched`)
		return
	}

	if (!result.isRule) {
		if (existing) {
			deleteReply({ ...target, commentId: existing.id })
			console.log(`auto-doc: deleted stale reply for ${cand.id} (no longer a rule)`)
		}
		return
	}

	const replyBodyFor = supersedesUrl =>
		buildReplyBody({ sourceCommentId: cand.id, scope: result.scope, rule: result.rule, supersedesUrl })

	if (!existing) {
		const url = postReply({ ...target, prNumber: common.prNumber, sourceCommentId: cand.id, body: replyBodyFor() })
		console.log(`auto-doc: posted reply for ${cand.id} -> ${url}`)
		return
	}

	// Existing reply with reactions → leave it (its 👍 was for the old wording)
	// and post a fresh superseding reply. Otherwise edit in place.
	if (validationReactionCount({ ...target, commentId: existing.id }) > 0) {
		const url = postReply({
			...target,
			prNumber: common.prNumber,
			sourceCommentId: cand.id,
			body: replyBodyFor(existing.html_url),
		})
		console.log(`auto-doc: superseded reply for ${cand.id} -> ${url}`)
	} else {
		editReply({ ...target, commentId: existing.id, body: replyBodyFor() })
		console.log(`auto-doc: edited reply for ${cand.id}`)
	}
}

function gather() {
	if (eventName === 'pull_request_review') {
		if (event.review.user?.type === 'Bot') return null
		if (hasAutoDocLabel(event.pull_request.labels)) return null
		const common = { prNumber: event.pull_request.number, prTitle: event.pull_request.title }
		// Known limitation: only the review's inline comments are classified, not
		// the review's top-level summary body (event.review.body). Rules stated in
		// the summary aren't captured — flag them inline or via /document instead.
		const inline = listReviewComments({ repoOwner, repoName, prNumber: common.prNumber, reviewId: event.review.id })
		const candidates = inline
			.filter(c => c.user?.type !== 'Bot')
			.map(c => ({
				id: c.id,
				body: c.body || '',
				isLineAnchored: true,
				filePath: c.path,
				line: c.line ?? c.original_line,
			}))
		return { common, candidates }
	}
	if (eventName === 'issue_comment') {
		if (event.comment.user?.type === 'Bot') return null
		if (!event.issue?.pull_request) return null // a plain issue, not a PR
		if (hasAutoDocLabel(event.issue.labels)) return null
		const common = { prNumber: event.issue.number, prTitle: event.issue.title }
		return { common, candidates: [{ id: event.comment.id, body: event.comment.body || '', isLineAnchored: false }] }
	}
	if (eventName === 'pull_request_review_comment') {
		if (event.comment.user?.type === 'Bot') return null
		if (hasAutoDocLabel(event.pull_request.labels)) return null
		const common = { prNumber: event.pull_request.number, prTitle: event.pull_request.title }
		const c = event.comment
		return {
			common,
			candidates: [
				{
					id: c.id,
					body: c.body || '',
					isLineAnchored: true,
					filePath: c.path,
					line: c.line ?? c.original_line,
				},
			],
		}
	}
	console.error(`auto-doc: unsupported event ${eventName}`)
	return null
}

const gathered = gather()
if (!gathered) {
	console.log('auto-doc: nothing to process for this event')
	process.exit(0)
}

const candidates = gathered.candidates.filter(c => c.body.trim().length > 0)
console.log(`auto-doc: ${candidates.length} candidate(s) to classify (event: ${eventName})`)

// Fetch all existing bot replies once (two paginated list calls) and look up
// per candidate in memory — avoids re-listing the whole PR for every comment.
// If this fails we can't tell which comments already have replies, so abort
// the whole run rather than risk posting duplicates (fail-closed).
let replies
try {
	replies = fetchBotReplies({ repoOwner, repoName, prNumber: gathered.common.prNumber })
} catch (err) {
	console.error(
		`auto-doc: could not fetch existing bot replies (${err?.message ?? err}); aborting to avoid duplicates`
	)
	process.exit(1)
}

for (const cand of candidates) {
	try {
		await processCandidate(cand, gathered.common, replies)
	} catch (err) {
		// One bad comment shouldn't sink the rest of the batch.
		console.error(`auto-doc: failed processing comment ${cand.id}: ${err?.message ?? err}`)
	}
}
