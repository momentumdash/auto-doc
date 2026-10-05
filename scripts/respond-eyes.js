/* global process */
// 👀 on the feedback respond.yml is about to act on, so the commenter knows it
// was picked up before the agent replies.
//   node respond-eyes.js   (env: REPO_OWNER, REPO_NAME, PR_NUMBER, EVENT_NAME, COMMENT_ID | REVIEW_ID, REVIEW_NODE_ID, REVIEW_BODY)
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

// CLI only when run directly, so test.js can import eyesTargets. Real paths,
// since Node resolves symlinks for import.meta.url.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const env = process.env
	const reviewComments = env.EVENT_NAME === 'pull_request_review'
		? listReviewComments({ repoOwner: env.REPO_OWNER, repoName: env.REPO_NAME, prNumber: env.PR_NUMBER, reviewId: env.REVIEW_ID })
		: []
	const targets = eyesTargets({ eventName: env.EVENT_NAME, commentId: env.COMMENT_ID, reviewBody: env.REVIEW_BODY, reviewNodeId: env.REVIEW_NODE_ID, reviewComments })
	for (const t of targets) react(`${env.REPO_OWNER}/${env.REPO_NAME}`, t)
}
