import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NODE } from './test-bin.js';

/**
 * A stand-in `pi` for the subprocess tests: it answers `--version`, serves
 * the RPC commands the capability probe sends, and replays a fixed JSONL
 * stream in `--mode json`. No model, no network, nothing under `~/.pi`.
 */
export interface FakePiConfig {
	version?: string;
	/** `serve` answers RPC commands; `exit` dies at once; `hang` never answers. */
	rpc?: 'serve' | 'exit' | 'hang';
	/** `selectable: false` makes `set_model` fail, as a model without credentials does. */
	models?: Array<{ provider: string; id: string; levels: string[]; selectable?: boolean }>;
	/**
	 * `--list-models` prints `models` only when this variable is set, as a
	 * provider whose key comes from the environment does. Unset: always.
	 */
	modelsNeedEnv?: string;
	/** `--mode json`: the stream lines to replay, as events. */
	stream?: unknown[];
	/** `--mode json`: stay alive this long after the stream, to be killed. */
	lingerMs?: number;
}

const SCRIPT = `
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, 'fake-pi.json'), 'utf8'));
const args = process.argv.slice(2);
const put = (record) => process.stdout.write(JSON.stringify(record) + '\\n');

if (args[0] === '--version') {
	console.log(config.version ?? '0.99.2');
} else if (args[0] === '--list-models') {
	const visible = !config.modelsNeedEnv || process.env[config.modelsNeedEnv];
	const models = visible ? (config.models ?? []) : [];
	if (models.length === 0) console.log('No models available. Use /login to log into a provider via OAuth or API key.');
	else {
		console.log('provider  model  context  max-out  thinking  images');
		for (const m of models) console.log(m.provider + '  ' + m.id + '  128K  16K  yes  no');
	}
} else if (args.includes('rpc')) {
	if (config.rpc === 'exit') process.exit(3);
	if (config.rpc === 'hang') setInterval(() => {}, 1000);
	else {
		let current = null;
		let inFlight = 0;
		let pending = '';
		const answer = (command) => {
			// A second command before the first is answered is the burst the
			// probe must never send: leave a marker the test can see.
			if (inFlight > 0) writeFileSync(join(here, 'burst'), command.type);
			inFlight++;
			setTimeout(() => {
				inFlight--;
				const reply = { id: command.id, type: 'response', command: command.type };
				if (command.type === 'get_available_models') {
					put({ ...reply, success: true, data: { models: config.models.map(({ provider, id }) => ({ provider, id, name: 'line\\u2028separator' })) } });
				} else if (command.type === 'set_model') {
					const model = config.models.find((m) => m.provider === command.provider && m.id === command.modelId);
					if (!model || model.selectable === false) {
						put({ ...reply, success: false, error: 'No API key for ' + command.provider + '/' + command.modelId });
					} else {
						current = model;
						put({ type: 'model_select', model: model.id });
						put({ ...reply, success: true, data: model });
					}
				} else if (command.type === 'get_available_thinking_levels') {
					put({ ...reply, success: true, data: { levels: current ? current.levels : ['off'] } });
				} else {
					put({ ...reply, success: false, error: 'unknown command' });
				}
			}, 5);
		};
		process.stdin.on('data', (chunk) => {
			pending += chunk;
			let nl;
			while ((nl = pending.indexOf('\\n')) !== -1) {
				answer(JSON.parse(pending.slice(0, nl)));
				pending = pending.slice(nl + 1);
			}
		});
		process.stdin.on('end', () => process.exit(0));
	}
} else {
	let stdin = '';
	process.stdin.on('data', (chunk) => (stdin += chunk));
	process.stdin.on('end', () => {
		writeFileSync(join(process.cwd(), 'pi-launch.json'), JSON.stringify({ args, stdin }));
		for (const event of config.stream ?? []) put(event);
		setTimeout(() => process.exit(0), config.lingerMs ?? 0);
	});
}
`;

/** Writes the fake into `<dir>/bin` and returns that directory, for the front of PATH. */
export function installFakePi(dir: string, config: FakePiConfig): string {
	const bin = join(dir, 'bin');
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, 'fake-pi.mjs'), SCRIPT);
	writeFileSync(join(bin, 'fake-pi.json'), JSON.stringify(config));
	writeFileSync(join(bin, 'pi'), `#!/bin/sh\nexec "${NODE}" "${join(bin, 'fake-pi.mjs')}" "$@"\n`, {
		mode: 0o755
	});
	return bin;
}
