import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

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
const recoveryRequests = [];
const recoveryServer = createServer((req, res) => {
	const url = new URL(req.url ?? '/', 'http://127.0.0.1');
	recoveryRequests.push({ method: req.method, path: url.pathname, search: url.search });
	res.writeHead(200, { 'content-type': 'application/json' });
	if (url.pathname.endsWith('/projects')) {
		res.end(JSON.stringify({ items: [{ id: 'prj_fixture', name: 'Fixture' }], next_cursor: null }));
		return;
	}
	res.end(
		JSON.stringify({
			id: 'iss_fixture',
			project_name: 'Fixture',
			project_archived_at: null,
			number: 520,
			title: 'Recovery fixture',
			description: '',
			labels: [],
			links: { blocked_by: [], blocks: [], duplicated_by: [] },
			duplicate_of: null,
			workflow: { name: 'Engineering' },
			state: { name: 'Implementation', category: 'active' },
			effective_state: { name: 'Implementation', category: 'active' },
			allowed_transitions: [],
			comments: [
				{
					id: 'cmt_old_detail',
					issue_id: 'iss_fixture',
					body: 'Recovered current body: use the existing JSON command.',
					actor: {
						user_id: 'u_fixture',
						user_name: 'Fixture Human',
						api_key_id: null,
						api_key_name: null
					},
					created_at: 1_700_000_000_000,
					updated_at: null
				}
			],
			updated_at: 1_700_000_000_000
		})
	);
});
await new Promise((resolveListen) => recoveryServer.listen(0, '127.0.0.1', resolveListen));
const recoveryUrl = `http://127.0.0.1:${recoveryServer.address().port}`;
const env = { ...process.env };
env.TINES_API_KEY = 'fixture-only-key';
env.TINES_API_URL = recoveryUrl;
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
await new Promise((resolveClose) => recoveryServer.close(resolveClose));
writeFileSync(join(resultDir, 'raw.jsonl'), stdout);
writeFileSync(join(resultDir, 'stderr.txt'), stderr);
writeFileSync(
	join(resultDir, 'recovery-requests.json'),
	`${JSON.stringify(recoveryRequests, null, 2)}\n`
);
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
	`${JSON.stringify({ number, arm, started_at: startedAt.toISOString(), ended_at: endedAt.toISOString(), elapsed_seconds: (endedAt - startedAt) / 1000, exit_code: exitCode, timed_out: timedOut, cold: true, model: 'gpt-6-astra', effort: 'high', harness: 'codex-cli 0.153.4', input_hashes: inputHashes }, null, 2)}\n`
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
