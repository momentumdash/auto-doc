/* global process */
// Fails a step when the agent was denied tool calls. claude-code-action already
// fails its own step on an error result, but ends green on denials, so later
// steps (replies, recording a cleanup as done) would otherwise run on a no-op.
//   node agent-verdict.js <execution_file>
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// GitHub's workflow-command escaping, so a denied command can't end its own
// ::error:: line and inject another workflow command.
const escapeData = s => s.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')

/** One line per denied call: the tool plus its command or file, capped. */
export function deniedCalls(messages) {
	const result = messages.findLast(m => m?.type === 'result')
	return (result?.permission_denials ?? []).map(({ tool_name: tool, tool_input: input = {} }) =>
		`denied ${tool}: ${input.command ?? input.file_path ?? JSON.stringify(input)}`.slice(0, 200)
	)
}

// CLI only when run directly, so test.js can import deniedCalls. Real paths:
// Node resolves symlinks for import.meta.url, and a mismatch would skip the
// check and pass silently.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	let denied
	try {
		denied = deniedCalls(JSON.parse(fs.readFileSync(process.argv[2], 'utf-8')))
	} catch {
		denied = ['no readable execution file from the agent']
	}
	for (const line of denied) console.log(`::error::${escapeData(line)}`)
	if (denied.length) process.exit(1)
}
