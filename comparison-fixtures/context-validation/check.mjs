import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('usage: node check.mjs <output.json>');
const output = JSON.parse(readFileSync(file, 'utf8'));
const required = {
	routine: ['global', 'project', 'state', 'combined', 'unknown', 'preserve'],
	conditional: ['inspect', 'Scouting', 'fresh', 'Re-propose', 'self-approv', 'Root'],
	old_decision: ['exact current bodies', 'cmt_old_detail', 'jq']
};
const acceptance = Object.fromEntries(
	Object.entries(required).map(([key, terms]) => [
		key,
		{
			accepted:
				typeof output[key] === 'string' &&
				terms.every((term) => output[key].toLowerCase().includes(term.toLowerCase())),
			missing: terms.filter(
				(term) =>
					typeof output[key] !== 'string' || !output[key].toLowerCase().includes(term.toLowerCase())
			)
		}
	])
);
process.stdout.write(`${JSON.stringify(acceptance, null, 2)}\n`);
if (Object.values(acceptance).some((result) => !result.accepted)) process.exitCode = 1;
