/* global process */
// Deterministic bookends around respond.yml's agent: 👀 the feedback before it
// runs, then judge its execution file so a silent no-op can't end green.
//   node respond-status.js eyes               (env: REPO_OWNER, REPO_NAME, PR_NUMBER, EVENT_NAME, COMMENT_ID | REVIEW_ID, REVIEW_NODE_ID, REVIEW_BODY)
//   node respond-status.js verdict <file>     (prints why the run failed and exits 1, or exits 0)
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { listReviewComments } from './github-comments.js'

/**
 * Where the 👀 goes. A review takes no REST reaction, but its node does via
 * GraphQL; skip that when the body is empty (a lone thread reply), since an
 * empty review renders only as its inline comments.
 */
export function eyesTargets({ eventName, commentId, reviewBody, reviewNodeId, reviewComments = [] }) {
	if (eventName === 'issue_comment') return [{ issueCommentId: commentId }]
	return [
		...(reviewBody?.trim() ? [{ reviewNodeId }] : []),
		...reviewComments.map(c => ({ reviewCommentId: c.id })),
	]
}

/**
 * Why the responder run failed, or null if it finished cleanly. A permission
 * denial counts: the action still reports success when the agent was blocked
 * from replying or pushing.
 */
export function runFailure(messages) {
	const result = Array.isArray(messages) ? messages.findLast(m => m?.type === 'result') : undefined
	if (!result) return 'no result from the agent'
	if (result.is_error) return `agent reported is_error (${result.subtype})`
	if (result.subtype !== 'success') return `agent ended with ${result.subtype}`
	const denied = result.permission_denials ?? []
	if (denied.length) return `${denied.length} tool call(s) denied: ${[...new Set(denied.map(d => d.tool_name))].join(', ')}`
	return null
}

function gh(args) {
	execFileSync('gh', args, { stdio: ['ignore', 'ignore', 'inherit'] })
}

function react(repo, target) {
	if (target.reviewNodeId) {
		gh(['api', 'graphql', '-f', 'query=mutation($id: ID!) { addReaction(input: {subjectId: $id, content: EYES}) { clientMutationId } }', '-f', `id=${target.reviewNodeId}`])
		return
	}
	const path = target.issueCommentId ? `issues/comments/${target.issueCommentId}` : `pulls/comments/${target.reviewCommentId}`
	gh(['api', '-X', 'POST', `repos/${repo}/${path}/reactions`, '-f', 'content=eyes'])
}

// CLI only when run directly, so test.js can import the pure helpers. Compare
// real paths: Node resolves symlinks for import.meta.url, and a mismatch would
// skip the CLI and let `verdict` pass silently.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [mode, file] = process.argv.slice(2)
	if (mode === 'eyes') {
		const env = process.env
		const reviewComments = env.EVENT_NAME === 'pull_request_review'
			? listReviewComments({ repoOwner: env.REPO_OWNER, repoName: env.REPO_NAME, prNumber: env.PR_NUMBER, reviewId: env.REVIEW_ID })
			: []
		const targets = eyesTargets({ eventName: env.EVENT_NAME, commentId: env.COMMENT_ID, reviewBody: env.REVIEW_BODY, reviewNodeId: env.REVIEW_NODE_ID, reviewComments })
		for (const t of targets) react(`${env.REPO_OWNER}/${env.REPO_NAME}`, t)
	} else if (mode === 'verdict') {
		let messages
		try {
			messages = JSON.parse(fs.readFileSync(file, 'utf-8'))
		} catch {
			console.log('no execution file from the agent')
			process.exit(1)
		}
		const reason = runFailure(messages)
		if (reason) {
			console.log(reason)
			process.exit(1)
		}
	} else {
		console.error(`respond-status: expected 'eyes' or 'verdict', got: ${mode}`)
		process.exit(1)
	}
}
