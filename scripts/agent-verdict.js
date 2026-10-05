/* global process */
// Fails a step when a claude-code-action run didn't really finish. The action
// reports success even when the agent was denied tools, so steps after it
// (replies, recording a cleanup as done) would otherwise run on a no-op.
//   node agent-verdict.js <execution_file>
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Why the run failed, or null if it finished cleanly. */
export function runFailure(messages) {
	const result = Array.isArray(messages) ? messages.findLast(m => m?.type === 'result') : undefined
	if (!result) return 'no result from the agent'
	if (result.is_error) return `agent reported is_error (${result.subtype})`
	if (result.subtype !== 'success') return `agent ended with ${result.subtype}`
	const denied = result.permission_denials ?? []
	if (denied.length) return `${denied.length} tool call(s) denied: ${[...new Set(denied.map(d => d.tool_name))].join(', ')}`
	return null
}

// CLI only when run directly, so test.js can import runFailure. Compare real
// paths: Node resolves symlinks for import.meta.url, and a mismatch would skip
// the check and pass silently.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	let reason
	try {
		reason = runFailure(JSON.parse(fs.readFileSync(process.argv[2], 'utf-8')))
	} catch {
		reason = 'no execution file from the agent'
	}
	if (reason) {
		console.log(`::error::${reason}`)
		process.exit(1)
	}
}
