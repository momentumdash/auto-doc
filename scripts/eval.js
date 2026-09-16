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
// The FALSE cases are the point of the "wide-area only" bar — narrow, line-local
// feedback the recall-first classifier used to capture.
const CASES = [
	// Wide-area rules — recurring conventions a new contributor must know.
	{ rule: true, body: "Don't import services into entities — entities should only depend on their constructor inputs." },
	{ rule: true, body: 'Always use `git mv` when renaming files so history is preserved.' },
	{ rule: true, body: 'Use the composition API for setup() and the options API everywhere else.' },
	{ rule: true, body: 'Every z-index needs a comment naming what it sits above and below.' },
	{ rule: true, body: 'Prefer Record types over Map for key-value data in TypeScript.' },
	{ rule: true, body: 'Verb-prefixed names are reserved for methods; state should read as a noun phrase.' },

	// Narrow / one-off / contentless — must be rejected.
	{ rule: false, body: 'Looks good!' },
	{ rule: false, body: 'Why did you do this here?' },
	{ rule: false, body: 'Thanks for the fix.' },
	{ rule: false, body: 'This variable name `x` is unclear here — maybe `count`?' },
	{ rule: false, body: 'Move this function above its first caller.' },
	{ rule: false, body: 'This if-branch could be simplified.' },
	{ rule: false, body: 'nit: extra blank line' },
	{ rule: false, body: 'Consider extracting this block into a helper.' },
]

const results = await Promise.all(
	CASES.map(async (c, i) => {
		const out = await classifyComment({
			body: c.body,
			prNumber: 0,
			sourceCommentId: `eval-${i}`,
			isLineAnchored: false,
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
