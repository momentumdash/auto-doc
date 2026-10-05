/* global process */
// 👀 on the feedback respond.yml is about to act on, so the commenter knows it
// was picked up before the agent replies.
//   node respond-eyes.js   (env: REPO_OWNER, REPO_NAME, PR_NUMBER, EVENT_NAME, COMMENT_ID | REVIEW_ID)
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gh, listReviewComments } from './github-comments.js'

/**
 * Where the 👀 goes. A review takes no REST reaction, but its node does via
 * GraphQL; skip that when the body is empty (a lone thread reply), since an
 * empty review renders only as its inline comments.
 */
export function eyesTargets({ eventName, commentId, review, reviewComments = [] }) {
	if (eventName === 'issue_comment') return [{ issueCommentId: commentId }]
	return [
		...(review.body?.trim() ? [{ reviewNodeId: review.node_id }] : []),
		...reviewComments.map(c => ({ reviewCommentId: c.id })),
	]
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
	const { REPO_OWNER: repoOwner, REPO_NAME: repoName, PR_NUMBER: prNumber, EVENT_NAME: eventName, COMMENT_ID: commentId, REVIEW_ID: reviewId } = process.env
	const isReview = eventName === 'pull_request_review'
	const review = isReview ? JSON.parse(gh(['api', `repos/${repoOwner}/${repoName}/pulls/${prNumber}/reviews/${reviewId}`, '--jq', '{body, node_id}'])) : undefined
	const reviewComments = isReview ? listReviewComments({ repoOwner, repoName, prNumber, reviewId }) : []
	for (const t of eyesTargets({ eventName, commentId, review, reviewComments })) react(`${repoOwner}/${repoName}`, t)
}
