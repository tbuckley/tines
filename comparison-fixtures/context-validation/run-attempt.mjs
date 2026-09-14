import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const [numberText, arm] = process.argv.slice(2);
const number = Number(numberText);
const allowed = new Map([
	['comment-full', 'comment-only.before.md'],
	['comment-selected', 'comment-only.after.md'],
	['procedure-inline', 'comment-only.before.md'],
	['procedure-skill', 'comment-only.before.md']
]);
if (!Number.isInteger(number) || number < 5 || number > 12 || !allowed.has(arm)) {
	throw new Error(
		'usage: node run-attempt.mjs <5..12> <comment-full|comment-selected|procedure-inline|procedure-skill>'
	);
}
const resultDir = join(here, 'results', `attempt-${number}`);
mkdirSync(join(here, 'results'), { recursive: true });
mkdirSync(resultDir, { recursive: false });
const stage = mkdtempSync(join(tmpdir(), `tines-528-${number}-`));
const launchDir = join(root, 'apps/web/src/lib/server/api/fixtures/launch-context');
const parts = [
	readFileSync(join(launchDir, allowed.get(arm)), 'utf8'),
	readFileSync(join(here, 'common.md'), 'utf8')
];
if (arm === 'procedure-inline') parts.push(readFileSync(join(here, 'inline-procedure.md'), 'utf8'));
if (arm === 'procedure-skill') {
	parts.push(readFileSync(join(here, 'skill-context.md'), 'utf8'));
	cpSync(join(here, 'skills'), join(stage, 'skills'), { recursive: true });
}
if (arm.startsWith('comment-')) {
	parts.push(readFileSync(join(here, 'skill-context.md'), 'utf8'));
	cpSync(join(here, 'skills'), join(stage, 'skills'), { recursive: true });
}
writeFileSync(join(stage, 'context.md'), `${parts.join('\n\n')}\n`);
cpSync(join(here, 'task.md'), join(stage, 'task.md'));
const prompt = readFileSync(join(stage, 'task.md'), 'utf8');
const startedAt = new Date();
const env = { ...process.env };
delete env.TINES_API_KEY;
delete env.TINES_API_URL;
const child = spawn(
	'codex',
	[
		'exec',
		'--ephemeral',
		'--json',
		'--skip-git-repo-check',
		'--sandbox',
		'workspace-write',
		'-m',
		'gpt-6-astra',
		'-c',
		'model_reasoning_effort="high"',
		'-C',
		stage,
		'-'
	],
	{ env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }
);
child.stdin.end(prompt);
let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => (stdout += chunk));
child.stderr.on('data', (chunk) => (stderr += chunk));
let timedOut = false;
const timer = setTimeout(() => {
	timedOut = true;
	process.kill(-child.pid, 'SIGTERM');
}, 300_000);
const exitCode = await new Promise((resolveExit) => child.on('close', resolveExit));
clearTimeout(timer);
const endedAt = new Date();
writeFileSync(join(resultDir, 'raw.jsonl'), stdout);
writeFileSync(join(resultDir, 'stderr.txt'), stderr);
if (readFileSafe(join(stage, 'output.json')) !== null) {
	cpSync(join(stage, 'output.json'), join(resultDir, 'output.json'));
}
const inputHashes = Object.fromEntries(
	['context.md', 'task.md'].map((name) => [
		name,
		createHash('sha256')
			.update(readFileSync(join(stage, name)))
			.digest('hex')
	])
);
writeFileSync(
	join(resultDir, 'run.json'),
	`${JSON.stringify({ number, arm, started_at: startedAt.toISOString(), ended_at: endedAt.toISOString(), elapsed_seconds: (endedAt - startedAt) / 1000, exit_code: exitCode, timed_out: timedOut, cold: true, model: 'gpt-6-astra', effort: 'high', harness: 'codex-cli 0.153.4', input_hashes }, null, 2)}\n`
);
rmSync(stage, { recursive: true, force: true });
if (exitCode !== 0 || timedOut) process.exitCode = 1;

function readFileSafe(path) {
	try {
		return readFileSync(path);
	} catch {
		return null;
	}
}
