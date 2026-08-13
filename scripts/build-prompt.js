/* global process */
import { integratorPrompt } from './prompts.js'

const which = process.argv[2]
const env = process.env

function fail(message) {
	console.error(`build-prompt: ${message}`)
	process.exit(1)
}

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
		})
	)
} else {
	// The extractor is now a direct SDK classifier (extract.js); only the
	// merge-time integrator still builds a claude-code-action prompt.
	console.error(`build-prompt: expected 'integrate', got: ${which}`)
	process.exit(1)
}
