/* global process */
// Opt-in eval for the classifier's precision — the one thing a pure unit test
// can't cover, because classifyComment calls the model. Guards against the
// wide-area bar in classify.js silently regressing back toward capturing every
// comment. Run with: ANTHROPIC_API_KEY=... node eval.js
//
// Skips (exit 0) when no API key is present, so it never fails a CI job that
// doesn't have one. Exits non-zero when any case disagrees with its label.
import { classifyComment } from './classify.js'

if (!process.env.ANTHROPIC_API_KEY) {
	console.log('eval: ANTHROPIC_API_KEY not set — skipping classifier eval')
	process.exit(0)
}

// Each case: a comment, and whether it states a wide-area rule worth recording.
// Fixtures are deliberately kept OFF the classifier prompt's own few-shot list,
// so this tests generalization rather than parroting the examples it was handed.
// The hardest FALSE cases (marked) read as preferences ("always", "prefer") but
// are scoped to the code in front of them — exactly the bar the precision rewrite
// exists to hold: a fix phrased as a preference is still not a rule.
const CASES = [
	// Wide-area rules: recurring conventions a new contributor must know, none of
	// which appear in the classifier's own prompt examples.
	{ rule: true, body: 'Store all timestamps in UTC; convert to the local zone only at render time.' },
	{ rule: true, body: 'Wrap every outbound third-party API call in a timeout so we never block indefinitely.' },
	{ rule: true, body: 'User-facing error messages must never include a stack trace or an internal file path.' },
	{ rule: true, body: 'Feature flags default to off and get removed within two releases of full rollout.' },
	{ rule: true, body: 'Prefer Record types over Map for key-value data in TypeScript.' },
	{ rule: true, body: 'Database migrations must be reversible; every up needs a matching down.' },

	// Narrow / one-off / contentless: must be rejected.
	{ rule: false, body: 'Looks good, thanks!' },
	{ rule: false, body: 'Can you rename `data` to `payload` on this line?' },
	{ rule: false, body: 'This block reads cleaner if you invert the condition.' },
	{ rule: false, body: 'nit: trailing whitespace' },
	{ rule: false, body: 'Is there a reason this runs before the fetch?' },

	// Preference-phrased but line-local: the discrimination the bar is built for.
	{ rule: false, isLineAnchored: true, body: "I'd destructure the props right here instead of reading props.x each time." },
	{ rule: false, isLineAnchored: true, body: 'Personally I always prefer an early return; can you flip this one?' },
]

const results = await Promise.all(
	CASES.map(async (c, i) => {
		const out = await classifyComment({
			body: c.body,
			prNumber: 0,
			sourceCommentId: `eval-${i}`,
			isLineAnchored: c.isLineAnchored ?? false,
			filePath: c.isLineAnchored ? 'src/components/Widget.tsx' : undefined,
			line: c.isLineAnchored ? 42 : undefined,
		})
		if (!out) return { ...c, got: null, pass: false }
		return { ...c, got: out.isRule, pass: out.isRule === c.rule }
	})
)

let failed = 0
for (const r of results) {
	const status = r.pass ? 'ok  ' : 'FAIL'
	if (!r.pass) failed++
	const got = r.got === null ? 'unavailable' : r.got
	console.log(`${status} expected=${r.rule} got=${got}  ${r.body}`)
}

console.log(`\neval: ${results.length - failed}/${results.length} passed`)
process.exit(failed > 0 ? 1 : 0)
