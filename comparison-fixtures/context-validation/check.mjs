import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TASKS = ['routine', 'conditional', 'old_decision'];

/**
 * Do not infer semantic correctness from prose. The former regex oracle
 * accepted a response containing every required sentence and its explicit
 * opposite. Only independent review can resolve meaning, so saved model
 * outputs remain unknown until such a review is attached. This machine check
 * is intentionally limited to the frozen output transport.
 */
export function score(output) {
	return Object.fromEntries(
		TASKS.map((task) => [
			task,
			{
				status: 'unknown',
				transport_valid: typeof output?.[task] === 'string' && output[task].trim().length > 0,
				reason: 'Semantic prose acceptance requires independent review; no review is attached.'
			}
		])
	);
}

function selfTest() {
	const positive = Object.fromEntries(TASKS.map((task) => [task, 'required instruction']));
	const contradictory = Object.fromEntries(
		TASKS.map((task) => [task, 'required instruction; do the exact opposite'])
	);
	for (const control of [positive, contradictory]) {
		const result = score(control);
		if (Object.values(result).some((entry) => entry.status !== 'unknown' || !entry.transport_valid))
			throw new Error(`unreviewed prose received a semantic verdict: ${JSON.stringify(result)}`);
	}
	const malformed = score({ routine: '', conditional: 1, old_decision: null });
	if (Object.values(malformed).some((entry) => entry.transport_valid))
		throw new Error('malformed transport was accepted');
	process.stdout.write('contradiction-safe unknown controls pass\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (process.argv[2] === '--self-test') selfTest();
	else {
		const file = process.argv[2];
		if (!file) throw new Error('usage: node check.mjs <output.json> | --self-test');
		const acceptance = score(JSON.parse(readFileSync(file, 'utf8')));
		process.stdout.write(`${JSON.stringify(acceptance, null, 2)}\n`);
		if (Object.values(acceptance).some((entry) => !entry.transport_valid)) process.exitCode = 1;
	}
}
