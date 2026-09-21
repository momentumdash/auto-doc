/* global process */
import { cleanupPrompt, integratorPrompt, respondPrompt } from './prompts.js'

const which = process.argv[2]
const env = process.env

function fail(message) {
	console.error(`build-prompt: ${message}`)
	process.exit(1)
}

const ignoreAuthors = (env.AUTO_DOC_IGNORE_AUTHORS || '').split(',').map(s => s.trim()).filter(Boolean)

if (which === 'integrate') {
	process.stdout.write(
		integratorPrompt({
			prNumber: env.PR_NUMBER || '',
			prTitle: env.PR_TITLE || '',
			repoOwner: env.REPO_OWNER || '',
			repoName: env.REPO_NAME || '',
			// Integration branch that doc PRs branch from and target. The
			// closed-PR checkout sits on the merged feature branch, so this must
			// be explicit — otherwise the doc branch inherits the feature diff.
			// The workflow resolves the fallback chain; bail rather than guess a
			// branch name that may not exist in the calling repo.
			baseBranch: env.BASE_BRANCH || fail('BASE_BRANCH is required'),
			docStyleFile: env.DOC_STYLE_FILE || 'docs/writing-docs.md',
			// Automation logins whose 👍/👎 must not count as human validation —
			// same denylist the extractor applies to comments (see extract.yml).
			ignoreAuthors,
		})
	)
} else if (which === 'respond') {
	process.stdout.write(
		respondPrompt({
			repoOwner: env.REPO_OWNER || '',
			repoName: env.REPO_NAME || '',
			prNumber: env.PR_NUMBER || fail('PR_NUMBER is required'),
			eventName: env.EVENT_NAME || fail('EVENT_NAME is required'),
			// Exactly one of these is set, depending on the event: a review id for
			// a submitted review, else the single comment's id.
			reviewId: env.REVIEW_ID || '',
			commentId: env.COMMENT_ID || '',
			// Automation logins to skip, beyond the structural non-bot guard.
			ignoreAuthors,
		})
	)
} else if (which === 'cleanup') {
	process.stdout.write(
		cleanupPrompt({
			repoOwner: env.REPO_OWNER || '',
			repoName: env.REPO_NAME || '',
			// Branch the cleanup PR branches from and targets. The workflow
			// resolves the fallback chain; bail rather than guess.
			baseBranch: env.BASE_BRANCH || fail('BASE_BRANCH is required'),
			docStyleFile: env.DOC_STYLE_FILE || 'docs/writing-docs.md',
			// Logins to request review from on the cleanup PR (empty = none).
			// Validate against GitHub's username charset so a stray value can't be
			// interpolated into the agent's gh command as anything but a login.
			reviewers: (env.REVIEWERS || '')
				.split(',')
				.map(s => s.trim())
				.filter(login => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?$/.test(login) && !login.endsWith('-')),
		})
	)
} else {
	// The extractor is a direct SDK classifier (extract.js); the integrator,
	// feedback responder, and weekly cleanup build claude-code-action prompts.
	console.error(`build-prompt: expected 'integrate', 'respond', or 'cleanup', got: ${which}`)
	process.exit(1)
}
