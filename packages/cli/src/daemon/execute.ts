import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { text } from 'node:stream/consumers';
import Ajv2020 from 'ajv/dist/2020.js';
import type { FinishRunRequest, RunnerAssignment, RunnerExecutionEvent } from '@tines/shared';
import schema from '../../schemas/runner-assignment.schema.json';
import { cliVersion } from '../version.js';
import {
	finishAssignment,
	killTree,
	launchAssignment,
	uploadRawLog,
	type ActiveRun,
	type ExecutionOptions,
	type RunReporter
} from './assignment.js';
import { installAgentCli } from './cli-refresh.js';
import { EffortCapabilityRefresher } from './effort-capabilities.js';
import { workspacesDir } from './store.js';
import { AMBIENT_CLI, RunTable } from './support.js';

async function readAssignment(): Promise<RunnerAssignment> {
	const input = await text(process.stdin);
	let value: unknown;
	try {
		value = JSON.parse(input);
	} catch {
		throw new Error('Expected one JSON runner assignment on stdin');
	}
	const validate = new Ajv2020({ allowUnionTypes: true }).compile<RunnerAssignment>(schema);
	if (!validate(value)) throw new Error('Input does not match runner-assignment.schema.json');
	return value;
}

export async function runExecutor(opts: ExecutionOptions): Promise<void> {
	const assignment = await readAssignment();
	const root = resolve(workspacesDir(opts.configDir));
	mkdirSync(root, { recursive: true, mode: 0o700 });
	if (assignment.resume) {
		const path = assignment.resume.workspace_path;
		if (
			dirname(path) !== root ||
			(existsSync(path) && dirname(realpathSync(path)) !== realpathSync(root))
		) {
			throw new Error('Resume workspace must belong to this executor workspace directory');
		}
	}

	const log = (message: string) => console.error(message);
	let finish: FinishRunRequest | undefined;
	let interrupted = false;
	let outputError: Error | undefined;
	const emit = (event: RunnerExecutionEvent) =>
		new Promise<void>((resolve, reject) => {
			if (outputError) return reject(outputError);
			process.stdout.write(JSON.stringify(event) + '\n', (err) => (err ? reject(err) : resolve()));
		});

	const client: RunReporter = {
		appendRunLog: (_id, body) => emit({ type: 'log', body }),
		async finishRun(_id, body) {
			finish = body;
		},
		async putRunLogRaw(_id, bytes) {
			const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			for (let i = 0; i < buffer.length; i += 48 * 1024) {
				await emit({ type: 'raw_log', data: buffer.subarray(i, i + 48 * 1024).toString('base64') });
			}
		}
	};
	const reportFinish = finishAssignment(opts.harness, client);
	let released!: (run: ActiveRun) => void;
	const completion = new Promise<ActiveRun>((resolve) => {
		released = resolve;
	});
	const table: RunTable<ActiveRun> = new RunTable<ActiveRun>({
		finish: reportFinish,
		release: released,
		persist() {
			const [run] = table.values();
			if (!run) return;
			const event: RunnerExecutionEvent =
				run.child?.pid && run.spawnedAt !== undefined
					? { type: 'started', pid: run.child.pid, started_at: run.spawnedAt }
					: { type: 'workspace', workspace_path: run.workspace };
			void emit(event).catch(brokenPipe);
		},
		log
	});
	let escalation: NodeJS.Timeout | undefined;
	const stop = (asInterruption: boolean) => {
		const run = table.markCanceled(assignment.run.id);
		if (!run) return;
		interrupted = asInterruption;
		const pid = run.child?.pid;
		if (pid) {
			killTree(pid, 'SIGTERM');
			escalation = setTimeout(() => killTree(pid, 'SIGKILL'), 5000);
			escalation.unref();
		}
	};
	const cancel = () => stop(false);
	const interrupt = () => stop(true);
	const brokenPipe = (error: Error) => {
		outputError = error;
		cancel();
	};
	process.stdout.on('error', brokenPipe);
	process.on('SIGTERM', cancel);
	process.on('SIGINT', interrupt);
	try {
		await launchAssignment(assignment, opts, {
			table,
			client,
			log,
			freshWorkspace: (id) => mkdtempSync(join(root, id + '-')),
			ensureCli: async () =>
				opts.cliRefresh ? installAgentCli({ configDir: opts.configDir, log }) : AMBIENT_CLI,
			effortRefresher: new EffortCapabilityRefresher(opts.harness, cliVersion())
		});
		const run = await completion;
		clearTimeout(run.timeout);
		if (run.canceled) run.drain?.();
		if (interrupted)
			await reportFinish(run, 'failed', 'executor shut down', { judgment: 'interrupted' });
		await run.batcher.finish();
		await uploadRawLog(run);
		if (outputError) throw outputError;
		if (finish) await emit({ type: 'finish', body: finish });
		else if (run.canceled) await emit({ type: 'canceled', workspace_path: run.workspace });
		else throw new Error('Run ended without a finish report');
	} finally {
		clearTimeout(escalation);
		process.off('SIGTERM', cancel);
		process.off('SIGINT', interrupt);
		process.stdout.off('error', brokenPipe);
	}
}
