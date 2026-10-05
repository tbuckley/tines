import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeStreamRenderer } from './claude-stream.js';
import { CodexStreamRenderer } from './codex-stream.js';
import { PiStreamRenderer } from './pi-stream.js';
import { RateLimitDetector } from './rate-limit.js';
import type { RunStreamRenderer } from './stream-summary.js';
import type { RunJudgment } from './support';
import {
	AMBIENT_CLI,
	buildHarnessInvocation,
	buildSpawnEnv,
	classifyExit,
	redactSecrets,
	SecretRedactor,
	CliRefresher,
	isNewerVersion,
	pathWithin,
	pendingSelfUpdate,
	exitLineForRun,
	expandCommandTemplate,
	formatExitLine,
	formatLaunchBanner,
	formatLaunchCommand,
	HARNESS_KINDS,
	LogBatcher,
	keepWorkspace,
	RunTable,
	shellQuote,
	type AgentCli,
	type ExitFacts,
	type HarnessKind,
	type ManagedRun,
	type RunOutcome
} from './support.js';

const input = {
	workspace: '/tmp/ws/run 1',
	promptFile: '/tmp/ws/run 1/prompt.md',
	prompt: 'Do the thing',
	model: 'claude-sonnet-5'
};

describe('shellQuote', () => {
	it('single-quotes, escaping embedded quotes', () => {
		expect(shellQuote('plain')).toBe("'plain'");
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
	});
});

describe('expandCommandTemplate', () => {
	it('substitutes all four placeholders, quoted', () => {
		expect(
			expandCommandTemplate('agent {prompt_file} -w {workspace} -m {model} -e {effort}', {
				...input,
				effort: 'high'
			})
		).toBe(`agent '/tmp/ws/run 1/prompt.md' -w '/tmp/ws/run 1' -m 'claude-sonnet-5' -e 'high'`);
	});

	it('an absent model substitutes an empty shell word', () => {
		expect(expandCommandTemplate('agent {model}', { ...input, model: null })).toBe("agent ''");
	});

	it.each([
		['omitted', input],
		['null', { ...input, effort: null }],
		['undefined', { ...input, effort: undefined }],
		['empty', { ...input, effort: '' }]
	])('an %s effort substitutes an empty shell word', (_label, value) => {
		expect(expandCommandTemplate('agent {effort}', value)).toBe("agent ''");
	});

	it('shell-quotes an effort containing spaces, quotes, and metacharacters', () => {
		expect(
			expandCommandTemplate('agent {effort}', { ...input, effort: "high speed's $&; $(boom)" })
		).toBe(`agent 'high speed'\\''s $&; $(boom)'`);
	});

	it('repeated placeholders all expand', () => {
		expect(expandCommandTemplate('agent {effort} {effort}', { ...input, effort: 'xhigh' })).toBe(
			`agent 'xhigh' 'xhigh'`
		);
	});

	it('leaves old templates and placeholder-like input data unchanged', () => {
		const oldInput = {
			...input,
			workspace: '/tmp/{effort}',
			promptFile: '/tmp/{effort}/prompt.md',
			model: 'model-{effort}',
			effort: 'high'
		};
		expect(expandCommandTemplate('agent {prompt_file} -w {workspace} -m {model}', oldInput)).toBe(
			`agent '/tmp/{effort}/prompt.md' -w '/tmp/{effort}' -m 'model-{effort}'`
		);
		expect(expandCommandTemplate('agent --fixed', oldInput)).toBe('agent --fixed');
	});
});

describe('buildHarnessInvocation', () => {
	it('claude_code reads the prompt from prompt.md via stdin — never argv (ARG_MAX)', () => {
		expect(buildHarnessInvocation({ harness: 'claude_code' }, input)).toEqual({
			file: 'sh',
			args: [
				'-c',
				`claude -p --output-format stream-json --verbose --model 'claude-sonnet-5' < '/tmp/ws/run 1/prompt.md'`
			]
		});
		expect(
			buildHarnessInvocation({ harness: 'claude_code' }, { ...input, model: null }).args
		).toEqual([
			'-c',
			`claude -p --output-format stream-json --verbose < '/tmp/ws/run 1/prompt.md'`
		]);
	});

	it('claude_code resumes the previous conversation when the assignment carries a session', () => {
		// Acceptance criterion 1: the send-back launches with `--resume`, in
		// the kept workspace, against the same prompt file.
		expect(
			buildHarnessInvocation({ harness: 'claude_code' }, { ...input, resumeSessionId: "sess-a'b" })
				.args
		).toEqual([
			'-c',
			`claude -p --resume 'sess-a'\\''b' --output-format stream-json --verbose --model 'claude-sonnet-5' < '/tmp/ws/run 1/prompt.md'`
		]);
		// A cold launch is byte-for-byte what it was before the flag existed.
		expect(buildHarnessInvocation({ harness: 'claude_code' }, input).args[1]).not.toContain(
			'--resume'
		);
	});

	it('codex: codex exec --json --skip-git-repo-check [--model] <prompt>', () => {
		expect(buildHarnessInvocation({ harness: 'codex' }, input)).toEqual({
			file: 'codex',
			args: [
				'exec',
				'--json',
				'--skip-git-repo-check',
				'--model',
				'claude-sonnet-5',
				'Do the thing'
			]
		});
	});

	it('routes effort through supported harness argv and preserves no-effort argv', () => {
		const claude = buildHarnessInvocation(
			{ harness: 'claude_code' },
			{ ...input, effort: 'xhigh' }
		);
		expect(claude.args[1]).toContain("--effort 'xhigh'");
		const codex = buildHarnessInvocation({ harness: 'codex' }, { ...input, effort: 'ultra' });
		expect(codex.args).toContain('-c');
		expect(codex.args).toContain('model_reasoning_effort="ultra"');
		expect(buildHarnessInvocation({ harness: 'codex' }, input).args).not.toContain('-c');
	});

	it('custom: sh -c with the expanded template; refuses without one', () => {
		expect(
			buildHarnessInvocation(
				{ harness: 'custom', command: 'run {prompt_file} --model {model} --effort {effort}' },
				{ ...input, effort: 'high' }
			)
		).toEqual({
			file: 'sh',
			args: ['-c', `run '/tmp/ws/run 1/prompt.md' --model 'claude-sonnet-5' --effort 'high'`]
		});
		expect(() => buildHarnessInvocation({ harness: 'custom' }, input)).toThrow(/--command/);
	});

	it('pi: JSON mode, the prompt on stdin, sessions kept inside the workspace', () => {
		// Cold, with nothing routed: no --model (Pi's own default), no --thinking.
		expect(buildHarnessInvocation({ harness: 'pi' }, { ...input, model: null })).toEqual({
			file: 'sh',
			args: [
				'-c',
				`pi --mode json --no-approve --session-dir '/tmp/ws/run 1/.pi-sessions' < '/tmp/ws/run 1/prompt.md'`
			]
		});
	});

	it('pi: model, effort and each materialized skill are named on the command line', () => {
		expect(
			buildHarnessInvocation(
				{ harness: 'pi' },
				{
					...input,
					model: 'omlx/qwen3-coder',
					effort: 'high',
					skillDirs: ['.agents/skills/i-have-adhd', '.agents/skills/tines-local-e2e']
				}
			).args
		).toEqual([
			'-c',
			`pi --mode json --no-approve --session-dir '/tmp/ws/run 1/.pi-sessions' --model 'omlx/qwen3-coder' --thinking 'high' --skill '.agents/skills/i-have-adhd' --skill '.agents/skills/tines-local-e2e' < '/tmp/ws/run 1/prompt.md'`
		]);
		// Never --approve: that would also trust a repository's own `.pi/` extensions.
		expect(buildHarnessInvocation({ harness: 'pi' }, input).args[1]).not.toMatch(/ --approve\b/);
	});

	it('pi: a resumed launch reopens the session from the same session dir', () => {
		const script = buildHarnessInvocation(
			{ harness: 'pi' },
			{ ...input, resumeSessionId: '01a10335-d7b7-7690-aa36-7f04c20b8cb9' }
		).args[1]!;
		expect(script).toContain(
			`--session-dir '/tmp/ws/run 1/.pi-sessions' --session '01a10335-d7b7-7690-aa36-7f04c20b8cb9' --model`
		);
		expect(buildHarnessInvocation({ harness: 'pi' }, input).args[1]).not.toContain('--session ');
	});

	it('pi: every interpolated value is shell-quoted', () => {
		const script = buildHarnessInvocation(
			{ harness: 'pi' },
			{
				workspace: "/tmp/it's",
				promptFile: "/tmp/it's/prompt.md",
				prompt: 'Do the thing',
				model: 'a; rm -rf /',
				effort: '$(id)',
				resumeSessionId: "s'1",
				skillDirs: [".agents/skills/o'no"]
			}
		).args[1]!;
		expect(script).toBe(
			`pi --mode json --no-approve --session-dir '/tmp/it'\\''s/.pi-sessions' --session 's'\\''1' --model 'a; rm -rf /' --thinking '$(id)' --skill '.agents/skills/o'\\''no' < '/tmp/it'\\''s/prompt.md'`
		);
	});
});

describe('formatLaunchBanner', () => {
	const meta = { harness: 'claude_code' as const, timeoutMinutes: 30, cliVersion: '0.0.1' };

	it('claude_code: the sh -c script verbatim, then the metadata line', () => {
		const invocation = buildHarnessInvocation({ harness: 'claude_code' }, input);
		expect(formatLaunchBanner(invocation, input, meta)).toBe(
			`$ claude -p --output-format stream-json --verbose --model 'claude-sonnet-5' < '/tmp/ws/run 1/prompt.md'\n` +
				`# tines runner: harness=claude_code model=claude-sonnet-5 effort=(provider-default) timeout=30m cli=0.0.1 workspace=/tmp/ws/run 1\n`
		);
	});

	it('a resumed launch says so in the banner, naming the run it continues', () => {
		// The acceptance criterion names the banner: "resumed run <prev-id>"
		// must be readable from the run's own log, not inferred from a DB row.
		const resumed = { ...input, resumeSessionId: 'sess-abc' };
		const banner = formatLaunchBanner(
			buildHarnessInvocation({ harness: 'claude_code' }, resumed),
			resumed,
			{ ...meta, resumedFromRunId: 'arun_prev' }
		);
		expect(banner).toContain('resumed=arun_prev');
		expect(banner).toContain("--resume 'sess-abc'");
		// Without the lineage the session id is still better than nothing.
		expect(
			formatLaunchBanner(buildHarnessInvocation({ harness: 'claude_code' }, resumed), resumed, meta)
		).toContain('resumed=sess-abc');
		// A cold launch carries no `resumed=` field at all.
		expect(
			formatLaunchBanner(buildHarnessInvocation({ harness: 'claude_code' }, input), input, meta)
		).not.toContain('resumed=');
	});

	it('a harness that cannot vary the model reads model=(fixed)', () => {
		const fixed = { ...input, model: null };
		const banner = formatLaunchBanner(
			buildHarnessInvocation({ harness: 'claude_code' }, fixed),
			fixed,
			meta
		);
		expect(banner).toContain('model=(fixed)');
		expect(banner).not.toContain('--model');
	});

	it('pi with no model named reads model=(pi default), not (fixed)', () => {
		const unrouted = { ...input, model: null };
		const pi = { ...meta, harness: 'pi' as const };
		expect(
			formatLaunchBanner(buildHarnessInvocation({ harness: 'pi' }, unrouted), unrouted, pi)
		).toBe(
			`$ pi --mode json --no-approve --session-dir '/tmp/ws/run 1/.pi-sessions' < '/tmp/ws/run 1/prompt.md'\n` +
				`# tines runner: harness=pi model=(pi default) effort=(provider-default) timeout=30m cli=0.0.1 workspace=/tmp/ws/run 1\n`
		);
		const routed = { ...input, model: 'omlx/qwen3-coder' };
		expect(
			formatLaunchBanner(buildHarnessInvocation({ harness: 'pi' }, routed), routed, pi)
		).toContain('model=omlx/qwen3-coder');
	});

	it('codex: argv shell-quoted, quoting only the words that need it', () => {
		const invocation = buildHarnessInvocation({ harness: 'codex' }, input);
		expect(formatLaunchBanner(invocation, input, { ...meta, harness: 'codex' })).toBe(
			`$ codex exec --json --skip-git-repo-check --model claude-sonnet-5 'Do the thing'\n` +
				`# tines runner: harness=codex model=claude-sonnet-5 effort=(provider-default) timeout=30m cli=0.0.1 workspace=/tmp/ws/run 1\n`
		);
	});

	it('codex: a stitched prompt on argv is elided, not dumped into the log', () => {
		const prompt = 'x'.repeat(25_000);
		const big = { ...input, prompt };
		const line = formatLaunchCommand(buildHarnessInvocation({ harness: 'codex' }, big));
		expect(line.length).toBeLessThan(400);
		expect(line).toContain('[+24840 chars]');
		expect(
			line.startsWith('codex exec --json --skip-git-repo-check --model claude-sonnet-5 ')
		).toBe(true);
	});

	it('custom: the template as expanded, not as written', () => {
		const routed = { ...input, effort: 'high' };
		const invocation = buildHarnessInvocation(
			{
				harness: 'custom',
				command: 'my-agent --model {model} --effort {effort} -w {workspace} < {prompt_file}'
			},
			routed
		);
		expect(formatLaunchBanner(invocation, routed, { ...meta, harness: 'custom' })).toBe(
			`$ my-agent --model 'claude-sonnet-5' --effort 'high' -w '/tmp/ws/run 1' < '/tmp/ws/run 1/prompt.md'\n` +
				`# tines runner: harness=custom model=claude-sonnet-5 effort=high timeout=30m cli=0.0.1 workspace=/tmp/ws/run 1\n`
		);
	});

	it('never leaks the run key: it rides in the environment, never in argv', () => {
		const runKey = 'trk_supersecretrunkey';
		const env = buildSpawnEnv({}, { binDir: null, apiKey: runKey, apiUrl: 'https://tines.test' });
		expect(env.TINES_API_KEY).toBe(runKey);
		for (const spec of [
			{ harness: 'claude_code' as const },
			{ harness: 'codex' as const },
			{ harness: 'pi' as const },
			{ harness: 'custom' as const, command: 'my-agent {prompt_file}' }
		]) {
			const banner = formatLaunchBanner(buildHarnessInvocation(spec, input), input, {
				...meta,
				harness: spec.harness
			});
			expect(banner).not.toContain(runKey);
			expect(banner).not.toContain('TINES_API_KEY');
		}
	});
});

describe('formatExitLine', () => {
	it('a clean exit reports its code and how long it took', () => {
		expect(formatExitLine({ code: 0, signal: null, durationMs: 192_000 })).toBe(
			'# tines runner: exit code=0 after 3m12s\n'
		);
		expect(formatExitLine({ code: 2, signal: null, durationMs: 900 })).toBe(
			'# tines runner: exit code=2 after 0m1s\n'
		);
	});

	it('a signalled exit reports the signal instead of a null code', () => {
		expect(formatExitLine({ code: null, signal: 'SIGKILL', durationMs: 61_000 })).toBe(
			'# tines runner: exit signal=SIGKILL after 1m1s\n'
		);
	});

	it('a timeout kill says so, so the log explains its own truncation', () => {
		expect(
			formatExitLine({ code: null, signal: 'SIGTERM', durationMs: 30 * 60_000, timedOut: true })
		).toBe('# tines runner: exit signal=SIGTERM (timed out) after 30m0s\n');
	});

	it('neither code nor signal (should not happen) still renders a line', () => {
		expect(formatExitLine({ code: null, signal: null, durationMs: 0 })).toBe(
			'# tines runner: exit code=? after 0m0s\n'
		);
	});
});

describe('exitLineForRun', () => {
	const exit = { code: null, signal: 'SIGTERM' as const, durationMs: 61_000 };

	it('a run we still own gets its line, timed out or not', () => {
		expect(exitLineForRun({ settled: false, timedOut: false }, exit)).toBe(
			'# tines runner: exit signal=SIGTERM after 1m1s\n'
		);
		expect(exitLineForRun({ settled: false, timedOut: true }, exit)).toBe(
			'# tines runner: exit signal=SIGTERM (timed out) after 1m1s\n'
		);
	});

	it('a settled run gets none — its batcher never flushes again', () => {
		expect(exitLineForRun({ settled: true, timedOut: false }, exit)).toBeNull();
	});
});

describe('classifyExit', () => {
	const facts = (over: Partial<ExitFacts>): ExitFacts => ({
		harness: 'claude_code',
		code: 0,
		signal: null,
		timedOut: false,
		timeoutMinutes: 30,
		secrets: [],
		...over
	});
	const limited = {
		resumeAt: 1_800_000_000_000,
		source: 'stream' as const,
		detail: 'five_hour limit rejected',
		limit: 'five_hour'
	};
	const providerError = { source: 'stderr' as const, detail: 'API Error: 529 overloaded' };

	it.each<[string, Partial<ExitFacts>, ReturnType<typeof classifyExit>]>([
		// -- what the close handler did before the extraction (claude_code, codex, custom)
		['exit 0 completes', {}, { status: 'completed' }],
		['codex exit 0 completes', { harness: 'codex' }, { status: 'completed' }],
		['custom exit 0 completes', { harness: 'custom' }, { status: 'completed' }],
		[
			'exit 0 completes even when the limiter saw a limit: the harness recovered',
			{ limited, providerError },
			{ status: 'completed' }
		],
		[
			'the daemon timeout wins over everything, including the SIGTERM it sent',
			{ timedOut: true, timeoutMinutes: 45, code: null, signal: 'SIGTERM', limited },
			{ status: 'failed', error: 'run exceeded the 45m timeout; harness killed' }
		],
		[
			'a timed-out harness that still exits 0 is a timeout',
			{ timedOut: true },
			{ status: 'failed', error: 'run exceeded the 30m timeout; harness killed' }
		],
		[
			'a signal is a plain failure, whatever the limiter read',
			{ code: null, signal: 'SIGKILL', limited, providerError },
			{ status: 'failed', error: 'harness killed by SIGKILL' }
		],
		[
			'a non-zero exit on a usage limit is rate_limited, with the reset time',
			{ code: 1, limited },
			{
				status: 'failed',
				error: 'rate limited: five_hour limit rejected',
				judgment: 'rate_limited',
				resume_at: 1_800_000_000_000,
				note: 'harness rate limited (five_hour limit rejected)'
			}
		],
		[
			'a usage limit with no parseable reset carries no resume_at',
			{ code: 1, limited: { ...limited, resumeAt: null } },
			{
				status: 'failed',
				error: 'rate limited: five_hour limit rejected',
				judgment: 'rate_limited',
				note: 'harness rate limited (five_hour limit rejected)'
			}
		],
		[
			'a usage limit outranks a provider error',
			{ code: 1, limited: { ...limited, resumeAt: null }, providerError },
			{
				status: 'failed',
				error: 'rate limited: five_hour limit rejected',
				judgment: 'rate_limited',
				note: 'harness rate limited (five_hour limit rejected)'
			}
		],
		[
			'a non-zero exit on a transient provider error is interrupted',
			{ code: 1, providerError },
			{
				status: 'failed',
				error: 'provider error: API Error: 529 overloaded',
				judgment: 'interrupted',
				note: 'transient provider error (API Error: 529 overloaded)'
			}
		],
		[
			"a plain non-zero exit is the issue's own failure",
			{ code: 2, limited: null, providerError: null },
			{ status: 'failed', error: 'harness exited with code 2' }
		],
		[
			'codex non-zero, where no limiter ran',
			{ harness: 'codex', code: 1 },
			{ status: 'failed', error: 'harness exited with code 1' }
		],
		[
			'a harness outcome is ignored for a harness whose exit code is trusted',
			{ harnessOutcome: { kind: 'error', detail: 'nope' } },
			{ status: 'completed' }
		],
		// -- pi: exit 0 proves nothing, the stream decides
		[
			'pi exit 0 with an ok stream completes',
			{ harness: 'pi', harnessOutcome: { kind: 'ok' } },
			{ status: 'completed' }
		],
		[
			'pi exit 0 on a 429 is rate_limited, with no resume_at: Pi names no reset',
			{ harness: 'pi', harnessOutcome: { kind: 'rate_limited', detail: '429: slow down' } },
			{
				status: 'failed',
				error: 'rate limited: 429: slow down',
				judgment: 'rate_limited',
				note: 'harness rate limited (429: slow down)'
			}
		],
		[
			'pi exit 0 on a provider error is interrupted',
			{ harness: 'pi', harnessOutcome: { kind: 'provider_error', detail: 'Connection error.' } },
			{
				status: 'failed',
				error: 'provider error: Connection error.',
				judgment: 'interrupted',
				note: 'transient provider error (Connection error.)'
			}
		],
		[
			'pi exit 0 on any other stream error fails the run, and takes the strike',
			{
				harness: 'pi',
				harnessOutcome: { kind: 'error', detail: 'pi ended without an assistant message' }
			},
			{ status: 'failed', error: 'pi: pi ended without an assistant message' }
		],
		[
			'pi non-zero exit on a 429 is still rate_limited: the stream names the cause',
			{ harness: 'pi', code: 1, harnessOutcome: { kind: 'rate_limited', detail: '429: x' } },
			{
				status: 'failed',
				error: 'rate limited: 429: x',
				judgment: 'rate_limited',
				note: 'harness rate limited (429: x)'
			}
		],
		[
			'pi non-zero exit on a provider error is still interrupted',
			{ harness: 'pi', code: 1, harnessOutcome: { kind: 'provider_error', detail: '503: down' } },
			{
				status: 'failed',
				error: 'provider error: 503: down',
				judgment: 'interrupted',
				note: 'transient provider error (503: down)'
			}
		],
		[
			'pi non-zero exit with an ok or plain-error stream is a plain failure',
			{ harness: 'pi', code: 1, harnessOutcome: { kind: 'error', detail: 'nope' } },
			{ status: 'failed', error: 'harness exited with code 1' }
		],
		[
			'codex non-zero exit keeps a rate-limited stream and its reset time: no strike',
			{
				harness: 'codex',
				code: 1,
				harnessOutcome: {
					kind: 'rate_limited',
					detail: 'You’ve hit your usage limit.',
					resumeAt: 1_800_000_000_000
				}
			},
			{
				status: 'failed',
				error: 'rate limited: You’ve hit your usage limit.',
				judgment: 'rate_limited',
				resume_at: 1_800_000_000_000,
				note: 'harness rate limited (You’ve hit your usage limit.)'
			}
		],
		[
			'codex non-zero exit keeps a provider-error stream: interrupted',
			{
				harness: 'codex',
				code: 1,
				harnessOutcome: { kind: 'provider_error', detail: 'Selected model is at capacity.' }
			},
			{
				status: 'failed',
				error: 'provider error: Selected model is at capacity.',
				judgment: 'interrupted',
				note: 'transient provider error (Selected model is at capacity.)'
			}
		],
		[
			'codex non-zero exit with a plain-error stream is a plain failure',
			{ harness: 'codex', code: 1, harnessOutcome: { kind: 'error', detail: 'nope' } },
			{ status: 'failed', error: 'harness exited with code 1' }
		],
		[
			'codex exit 0 is success whatever its stream said: only pi is judged from the stream there',
			{
				harness: 'codex',
				harnessOutcome: { kind: 'rate_limited', detail: 'limit', resumeAt: 1_800_000_000_000 }
			},
			{ status: 'completed' }
		],
		[
			"the detector's usage limit outranks the stream outcome on the same exit",
			{
				code: 1,
				limited,
				harnessOutcome: { kind: 'provider_error', detail: 'from the stream' }
			},
			{
				status: 'failed',
				error: 'rate limited: five_hour limit rejected',
				judgment: 'rate_limited',
				resume_at: 1_800_000_000_000,
				note: 'harness rate limited (five_hour limit rejected)'
			}
		],
		[
			'an effort mismatch the daemon killed the run for outranks the signal it sent',
			{
				harness: 'pi',
				code: null,
				signal: 'SIGTERM',
				effortMismatch: 'pi applied thinking level off, not the assigned high',
				harnessOutcome: { kind: 'ok' }
			},
			{ status: 'failed', error: 'pi applied thinking level off, not the assigned high' }
		],
		[
			'the timeout outranks an effort mismatch',
			{ harness: 'pi', timedOut: true, effortMismatch: 'pi applied thinking level off' },
			{ status: 'failed', error: 'run exceeded the 30m timeout; harness killed' }
		]
	])('%s', (_name, over, verdict) => {
		expect(classifyExit(facts(over))).toEqual(verdict);
	});

	it('masks secret env values in every detail that reaches the report', () => {
		const secrets = ['hunter2'];
		expect(
			classifyExit(
				facts({
					code: 1,
					limited: { ...limited, detail: 'key hunter2 is over its limit' },
					secrets
				})
			)
		).toMatchObject({
			error: 'rate limited: key *** is over its limit',
			note: 'harness rate limited (key *** is over its limit)'
		});
		expect(
			classifyExit(
				facts({ code: 1, providerError: { source: 'stream', detail: 'hunter2' }, secrets })
			).error
		).toBe('provider error: ***');
		for (const kind of ['rate_limited', 'provider_error', 'error'] as const) {
			const verdict = classifyExit(
				facts({ harness: 'pi', harnessOutcome: { kind, detail: '401: bad key hunter2' }, secrets })
			);
			expect(JSON.stringify(verdict)).not.toContain('hunter2');
			expect(verdict.error).toContain('bad key ***');
		}
		for (const kind of ['rate_limited', 'provider_error'] as const) {
			const verdict = classifyExit(
				facts({
					harness: 'codex',
					code: 1,
					harnessOutcome: { kind, detail: 'key hunter2 refused' },
					secrets
				})
			);
			expect(JSON.stringify(verdict)).not.toContain('hunter2');
			expect(verdict.error).toContain('key *** refused');
			expect(verdict.note).toContain('key *** refused');
		}
		expect(
			classifyExit(facts({ harness: 'pi', effortMismatch: 'model hunter2 clamped', secrets })).error
		).toBe('model *** clamped');
	});
});

describe('provider refusal parity', () => {
	// Every model harness must turn its provider's usage limit into a hold and
	// its provider's outage into an interruption. A harness added without a
	// fixture here fails `tsc` through the Record and the key check below.
	type ModelHarness = Exclude<HarnessKind, 'custom'>;
	interface Fixture {
		/** The harness's stdout, one JSON event per line. */
		stdout: unknown[];
		code: number;
	}

	const codexRefusal = (message: string): Fixture => ({
		stdout: [
			{ type: 'thread.started', thread_id: 'thread_123' },
			{ type: 'turn.started' },
			{ type: 'error', message },
			{ type: 'turn.failed', error: { message } }
		],
		code: 1
	});
	// Pi exits 0 when the model call failed.
	const piRefusal = (errorMessage: string): Fixture => ({
		stdout: [
			{
				type: 'message_end',
				message: { role: 'assistant', content: [], stopReason: 'error', errorMessage }
			}
		],
		code: 0
	});

	const REFUSALS: Record<ModelHarness, { usageLimit: Fixture; providerFailure: Fixture }> = {
		claude_code: {
			usageLimit: {
				stdout: [
					{
						type: 'rate_limit_event',
						rate_limit_info: {
							status: 'rejected',
							resetsAt: 1_800_000_000,
							rateLimitType: 'five_hour'
						}
					}
				],
				code: 1
			},
			providerFailure: {
				stdout: [{ type: 'result', is_error: true, result: 'API Error: 529 Overloaded' }],
				code: 1
			}
		},
		codex: {
			usageLimit: codexRefusal(
				'You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 7th, 2026 2:58 PM.'
			),
			providerFailure: codexRefusal('Selected model is at capacity. Please try a different model.')
		},
		pi: {
			usageLimit: piRefusal('429: {"message":"Rate limit reached","type":"rate_limit_error"}'),
			providerFailure: piRefusal('503: overloaded')
		}
	};

	/**
	 * Runs a fixture through what the daemon builds for the harness and judges
	 * it as the daemon's close handler does (`child.on('close')` in daemon.ts).
	 */
	function verdictFor(harness: ModelHarness, fixture: Fixture) {
		const emit = () => {};
		let limiter: RateLimitDetector | undefined;
		let renderer: RunStreamRenderer;
		switch (harness) {
			case 'claude_code': {
				const detector = new RateLimitDetector();
				limiter = detector;
				renderer = new ClaudeStreamRenderer(emit, (event) => detector.noteStreamEvent(event));
				break;
			}
			case 'codex':
				renderer = new CodexStreamRenderer(emit);
				break;
			case 'pi':
				renderer = new PiStreamRenderer(emit);
				break;
		}
		renderer.write(fixture.stdout.map((event) => `${JSON.stringify(event)}\n`).join(''));
		renderer.finish();
		limiter?.finish();
		return classifyExit({
			harness,
			code: fixture.code,
			signal: null,
			timedOut: false,
			timeoutMinutes: 30,
			limited: limiter?.signal() ?? null,
			providerError: limiter?.providerError() ?? null,
			harnessOutcome: renderer.summary().harnessOutcome,
			secrets: []
		});
	}

	const harnesses = Object.keys(REFUSALS) as ModelHarness[];

	it('has a fixture pair for every model harness', () => {
		expect([...harnesses].sort()).toEqual(HARNESS_KINDS.filter((kind) => kind !== 'custom').sort());
	});

	it.each(harnesses)('%s: a usage limit is rate_limited, not a strike', (harness) => {
		expect(verdictFor(harness, REFUSALS[harness].usageLimit)).toMatchObject({
			status: 'failed',
			judgment: 'rate_limited',
			error: expect.stringMatching(/^rate limited: /)
		});
	});

	it.each(harnesses)('%s: a provider failure is interrupted, not a strike', (harness) => {
		expect(verdictFor(harness, REFUSALS[harness].providerFailure)).toMatchObject({
			status: 'failed',
			judgment: 'interrupted',
			error: expect.stringMatching(/^provider error: /)
		});
	});

	it('codex carries the reset time it printed; pi names none', () => {
		expect(verdictFor('codex', REFUSALS.codex.usageLimit).resume_at).toBe(
			new Date(2026, 9, 7, 14, 58).getTime() + 60_000
		);
		expect(verdictFor('pi', REFUSALS.pi.usageLimit)).not.toHaveProperty('resume_at');
	});
});

describe('LogBatcher', () => {
	it('flushes when the buffer reaches maxBytes, preserving order', async () => {
		const sent: string[] = [];
		const batcher = new LogBatcher(async (chunk) => void sent.push(chunk), { maxBytes: 10 });
		batcher.append('12345');
		expect(sent).toEqual([]); // under the threshold: waiting for the timer
		batcher.append('67890'); // hits 10 bytes: flushes immediately
		await batcher.flush();
		expect(sent).toEqual(['1234567890']);
	});

	it('manual flush drains the buffer and serializes sends', async () => {
		const sent: string[] = [];
		let resolveFirst!: () => void;
		const gate = new Promise<void>((r) => (resolveFirst = r));
		const batcher = new LogBatcher(
			async (chunk) => {
				if (sent.length === 0) await gate;
				sent.push(chunk);
			},
			{ maxBytes: 1 }
		);
		batcher.append('a'); // starts a send blocked on the gate
		batcher.append('b'); // queues behind it
		resolveFirst();
		await batcher.flush();
		expect(sent).toEqual(['a', 'b']);
	});

	it('retries a failed chunk on the next flush, keeping its seq and its place', async () => {
		const sent: { chunk: string; seq: number }[] = [];
		const errors: unknown[] = [];
		let fail = true;
		const batcher = new LogBatcher(
			async (chunk, seq) => {
				if (fail) throw new Error('offline');
				sent.push({ chunk, seq });
			},
			{ maxBytes: 1, onError: (e) => errors.push(e) }
		);
		batcher.append('a');
		await batcher.flush();
		// Every attempt while offline reports; how many depends on flush cadence.
		expect(errors.length).toBeGreaterThanOrEqual(1);
		// Dropping 'a' would put a hole in a log that is now durable, so it
		// waits — and goes out before 'b', under the seq it was first given.
		fail = false;
		batcher.append('b');
		await batcher.flush();
		expect(sent).toEqual([
			{ chunk: 'a', seq: 1 },
			{ chunk: 'b', seq: 2 }
		]);
	});

	it('drops the oldest backlog past the pending cap, with a marker', async () => {
		const sent: string[] = [];
		let fail = true;
		const batcher = new LogBatcher(
			async (chunk) => {
				if (fail) throw new Error('offline');
				sent.push(chunk);
			},
			{ maxBytes: 1, maxPendingBytes: 8 }
		);
		for (const text of ['aaaa', 'bbbb', 'cccc']) {
			batcher.append(text);
			await batcher.flush();
		}
		fail = false;
		await batcher.flush();
		expect(sent.join('')).toContain('bytes lost');
		expect(sent.join('')).toContain('cccc');
	});

	it('an empty flush resolves without sending', async () => {
		const sent: string[] = [];
		const batcher = new LogBatcher(async (chunk) => void sent.push(chunk));
		await batcher.flush();
		expect(sent).toEqual([]);
	});
});

describe('keepWorkspace', () => {
	it.each([
		['never', 'completed', false],
		['never', 'failed', false],
		['failed', 'completed', false],
		['failed', 'failed', true],
		['always', 'completed', true],
		['always', 'failed', true]
	] as const)('%s + %s → %s', (mode, outcome, expected) => {
		expect(keepWorkspace(mode, outcome)).toBe(expected);
	});
});

describe('RunTable', () => {
	interface TestRun extends ManagedRun {
		flushed?: number;
	}

	function harness(opts: { keep?: (outcome: RunOutcome) => boolean } = {}) {
		const finishes: {
			runId: string;
			status: string;
			error?: string;
			judgment?: RunJudgment;
		}[] = [];
		const released: { runId: string; keep: boolean; outcome: RunOutcome }[] = [];
		const cancellationAcks: { runId: string; token: string; released: boolean }[] = [];
		const notes: string[] = [];
		const logs: string[] = [];
		let persists = 0;
		let failFinish: string | null = null;
		const table = new RunTable<TestRun>(
			{
				finish: async (run, status, error, judgment) => {
					if (failFinish) throw new Error(failFinish);
					finishes.push({ runId: run.runId, status, error, judgment });
				},
				release: (run, { keep, outcome }) => released.push({ runId: run.runId, keep, outcome }),
				acknowledgeCancellation: async (run) => {
					cancellationAcks.push({
						runId: run.runId,
						token: run.cancellationToken!,
						released: released.some((item) => item.runId === run.runId)
					});
				},
				noteKept: (run) => notes.push(run.runId),
				persist: () => (persists += 1),
				log: (m) => logs.push(m)
			},
			opts
		);
		const run = (runId: string): TestRun => ({
			runId,
			workspace: `/ws/${runId}`,
			canceled: false,
			timedOut: false,
			settled: false
		});
		return {
			table,
			run,
			finishes,
			released,
			cancellationAcks,
			releasedIds: () => released.map((r) => r.runId),
			notes,
			logs,
			setFailFinish: (m: string) => (failFinish = m),
			persistCount: () => persists
		};
	}

	it('a normal finish flushes, reports once, and cleans up', async () => {
		const h = harness();
		const run = h.run('arun_1');
		let flushes = 0;
		run.flush = async () => void (flushes += 1);
		h.table.track(run);
		await h.table.finishAndCleanup(run, 'completed');
		expect(flushes).toBe(1);
		expect(h.finishes).toEqual([{ runId: 'arun_1', status: 'completed', error: undefined }]);
		expect(h.releasedIds()).toEqual(['arun_1']);
		expect(h.table.ids()).toEqual([]);
		// A second call (a racing exit handler) reports nothing more.
		await h.table.finishAndCleanup(run, 'failed', 'late');
		expect(h.finishes).toHaveLength(1);
	});

	it("a shutdown's finish is marked interrupted so the supervisor spares the issue", async () => {
		const h = harness();
		const run = h.run('arun_1');
		h.table.track(run);
		await h.table.finishAndCleanup(run, 'failed', 'daemon shut down', {
			judgment: 'interrupted'
		});
		expect(h.finishes).toEqual([
			{
				runId: 'arun_1',
				status: 'failed',
				error: 'daemon shut down',
				judgment: { judgment: 'interrupted' }
			}
		]);
	});

	it('forwards a rate-limited judgment, resume time and all, unchanged', async () => {
		const h = harness();
		const run = h.run('arun_1');
		h.table.track(run);
		await h.table.finishAndCleanup(run, 'failed', 'rate limited: session limit', {
			judgment: 'rate_limited',
			resume_at: 1_788_739_200_000
		});
		expect(h.finishes).toEqual([
			{
				runId: 'arun_1',
				status: 'failed',
				error: 'rate limited: session limit',
				judgment: { judgment: 'rate_limited', resume_at: 1_788_739_200_000 }
			}
		]);
	});

	it('an ordinary failure carries no judgment: the run failed, and that is a strike', async () => {
		const h = harness();
		const run = h.run('arun_1');
		h.table.track(run);
		await h.table.finishAndCleanup(run, 'failed', 'harness exited with code 1');
		expect(h.finishes[0].judgment).toBeUndefined();
	});

	it('cancel during materialization: the later failure path still cleans up, without a report', async () => {
		const h = harness();
		const run = h.run('arun_1');
		h.table.track(run);
		// The poll's cancels settled it while the workspace was materializing
		// (no pid yet) …
		expect(h.table.markCanceled('arun_1')).toBe(run);
		expect(run.settled).toBe(true);
		// … and the clone-failure (or spawn-error) branch then hits
		// finishAndCleanup: the slot, workspace, and state entry are released,
		// and nothing is finish-reported over the supervisor's settlement.
		await h.table.finishAndCleanup(run, 'failed', 'git clone failed');
		expect(h.finishes).toEqual([]);
		expect(h.releasedIds()).toEqual(['arun_1']);
		expect(h.table.size).toBe(0);
	});

	it('markCanceled ignores unknown and already-settled runs', async () => {
		const h = harness();
		const run = h.run('arun_1');
		h.table.track(run);
		expect(h.table.markCanceled('arun_other')).toBeNull();
		h.table.markCanceled('arun_1');
		expect(h.table.markCanceled('arun_1')).toBeNull();
	});

	it('a rejected finish report still cleans up (the supervisor settled it first)', async () => {
		const h = harness();
		const run = h.run('arun_1');
		h.table.track(run);
		h.setFailFinish('run_already_ended');
		await h.table.finishAndCleanup(run, 'failed', 'harness exited with code 1');
		expect(h.releasedIds()).toEqual(['arun_1']);
		expect(h.table.size).toBe(0);
		expect(h.logs.some((m) => m.includes('not accepted'))).toBe(true);
	});

	it('the keep decision reaches release, and only a kept run is noted in its log', async () => {
		const h = harness({ keep: (outcome) => outcome === 'failed' });
		// A completed run under keep-on-failed: removed, and nothing appended.
		const ok = h.run('arun_ok');
		h.table.track(ok);
		await h.table.finishAndCleanup(ok, 'completed');
		expect(h.released).toEqual([{ runId: 'arun_ok', keep: false, outcome: 'completed' }]);
		expect(h.notes).toEqual([]);

		// A failure: kept, with the error recorded as the marker's note.
		const bad = h.run('arun_bad');
		h.table.track(bad);
		await h.table.finishAndCleanup(bad, 'failed', 'harness exited with code 1');
		expect(h.released[1]).toEqual({ runId: 'arun_bad', keep: true, outcome: 'failed' });
		expect(h.notes).toEqual(['arun_bad']);
		expect(bad.endNote).toBe('harness exited with code 1');
	});

	it('notes a kept workspace before the flush — the only window an append still ships in', async () => {
		const h = harness({ keep: () => true });
		const run = h.run('arun_1');
		let letFlushFinish!: () => void;
		const gate = new Promise<void>((resolve) => (letFlushFinish = resolve));
		let flushed = false;
		run.flush = () => gate.then(() => void (flushed = true));
		h.table.track(run);
		const settling = h.table.finishAndCleanup(run, 'failed', 'timed out');
		// Synchronous up to the flush: the note is already in the batcher.
		expect(h.notes).toEqual(['arun_1']);
		expect(flushed).toBe(false);
		letFlushFinish();
		await settling;
		expect(flushed).toBe(true);
	});

	it('a supervisor cancel releases as a failure, with no note and no finish report', async () => {
		const h = harness({ keep: (outcome) => outcome === 'failed' });
		const run = h.run('arun_1');
		h.table.track(run);
		h.table.markCanceled(run.runId);
		// The exit handler's finishAndCleanup degrades to cleanup — which is
		// exactly the path that must still keep the workspace.
		await h.table.finishAndCleanup(run, 'failed', 'harness killed by SIGTERM');
		expect(h.finishes).toEqual([]);
		expect(h.notes).toEqual([]);
		expect(h.released).toEqual([{ runId: 'arun_1', keep: true, outcome: 'failed' }]);
		expect(h.cancellationAcks).toEqual([]); // Older server: no request token.
	});

	it('acknowledges a token only after local cancellation cleanup', async () => {
		const h = harness();
		const run = h.run('arun_1');
		h.table.track(run);
		h.table.noteCancellationRequest(run.runId, 'can_request_1');
		expect(h.cancellationAcks).toEqual([]);
		h.table.markCanceled(run.runId);
		expect(h.cancellationAcks).toEqual([]);
		await h.table.finishAndCleanup(run, 'failed', 'killed');
		expect(h.cancellationAcks).toEqual([
			{ runId: run.runId, token: 'can_request_1', released: true }
		]);
		expect(h.finishes).toEqual([]);
	});

	it('a bare cleanup defaults to the failed outcome', () => {
		const h = harness({ keep: (outcome) => outcome === 'failed' });
		const run = h.run('arun_1');
		h.table.track(run);
		h.table.cleanup(run);
		expect(h.released).toEqual([{ runId: 'arun_1', keep: true, outcome: 'failed' }]);
	});

	it('without a keep decision, nothing is ever kept', async () => {
		const h = harness();
		const run = h.run('arun_1');
		h.table.track(run);
		await h.table.finishAndCleanup(run, 'failed', 'boom');
		expect(h.released).toEqual([{ runId: 'arun_1', keep: false, outcome: 'failed' }]);
		expect(h.notes).toEqual([]);
	});

	it('cleanup is idempotent and persists membership changes', () => {
		const h = harness();
		const run = h.run('arun_1');
		h.table.track(run);
		const after = h.persistCount();
		h.table.cleanup(run);
		h.table.cleanup(run);
		expect(h.persistCount()).toBe(after + 2);
		expect(h.releasedIds()).toEqual(['arun_1', 'arun_1']); // release itself is idempotent (rm -rf force)
	});
});

describe('buildSpawnEnv', () => {
	const base = { PATH: '/usr/bin:/bin', HOME: '/home/agent' };

	it('prepends the managed CLI bin dir to PATH and sets the run credentials', () => {
		expect(
			buildSpawnEnv(base, {
				binDir: '/cfg/cli/node_modules/.bin',
				apiKey: 'k',
				apiUrl: 'https://t'
			})
		).toEqual({
			HOME: '/home/agent',
			PATH: `/cfg/cli/node_modules/.bin${delimiter}/usr/bin:/bin`,
			TINES_API_KEY: 'k',
			TINES_API_URL: 'https://t'
		});
	});

	it('leaves PATH untouched when there is no managed CLI', () => {
		expect(buildSpawnEnv(base, { binDir: null, apiKey: 'k', apiUrl: 'https://t' }).PATH).toBe(
			'/usr/bin:/bin'
		);
	});

	it('canonicalizes the API URL placed in the spawned harness environment', () => {
		expect(
			buildSpawnEnv(base, { binDir: null, apiKey: 'k', apiUrl: 'https://t.test///' }).TINES_API_URL
		).toBe('https://t.test');
	});

	it('tolerates an environment with no PATH at all', () => {
		expect(buildSpawnEnv({}, { binDir: '/cfg/bin', apiKey: 'k', apiUrl: 'https://t' }).PATH).toBe(
			'/cfg/bin'
		);
	});
});

describe('CliRefresher', () => {
	const fresh = (version: string): AgentCli => ({
		binDir: '/cfg/cli/node_modules/.bin',
		version,
		source: 'fresh'
	});

	/** A refresher over a counted, manually-resolved install and a fake clock. */
	function harness(install: (n: number) => Promise<AgentCli>, ttlMs = 1000) {
		let now = 0;
		let calls = 0;
		const refresher = new CliRefresher(() => install(++calls), { ttlMs, now: () => now });
		return {
			refresher,
			get calls() {
				return calls;
			},
			advance: (ms: number) => (now += ms)
		};
	}

	it('installs once, then serves the cache until the TTL elapses', async () => {
		const h = harness((n) => Promise.resolve(fresh(`0.0.${n}`)));
		expect(await h.refresher.ensure()).toEqual(fresh('0.0.1'));
		expect(await h.refresher.ensure()).toEqual(fresh('0.0.1'));
		expect(h.calls).toBe(1);

		h.advance(999);
		await h.refresher.ensure();
		expect(h.calls).toBe(1);

		h.advance(1);
		expect(await h.refresher.ensure()).toEqual(fresh('0.0.2'));
		expect(h.calls).toBe(2);
	});

	it('coalesces concurrent launches into one in-flight install', async () => {
		let release!: (cli: AgentCli) => void;
		const h = harness(() => new Promise<AgentCli>((resolve) => (release = resolve)));
		const first = h.refresher.ensure();
		const second = h.refresher.ensure();
		await Promise.resolve(); // the install effect starts on a microtask
		const third = h.refresher.ensure(); // …and this one joins it mid-flight
		expect(h.calls).toBe(1);
		release(fresh('0.0.9'));
		expect(await Promise.all([first, second, third])).toEqual([
			fresh('0.0.9'),
			fresh('0.0.9'),
			fresh('0.0.9')
		]);
		expect(h.calls).toBe(1);
	});

	it('TTL-gates failed attempts too — an offline machine is not retried per launch', async () => {
		const h = harness(() => Promise.resolve(AMBIENT_CLI));
		expect(await h.refresher.ensure()).toEqual(AMBIENT_CLI);
		await h.refresher.ensure();
		expect(h.calls).toBe(1);
	});

	it('degrades to the ambient PATH when install throws, rather than failing the launch', async () => {
		const h = harness(() => Promise.reject(new Error('boom')));
		await expect(h.refresher.ensure()).resolves.toEqual(AMBIENT_CLI);
		h.advance(1000);
		await expect(h.refresher.ensure()).resolves.toEqual(AMBIENT_CLI);
		expect(h.calls).toBe(2);
	});

	it('settled() waits out an in-flight install and never starts one', async () => {
		let release!: (cli: AgentCli) => void;
		const h = harness(() => new Promise<AgentCli>((resolve) => (release = resolve)));
		// Nothing in flight: resolves at once, and the TTL-expired refresher
		// did not take that as a cue to install.
		await h.refresher.settled();
		expect(h.calls).toBe(0);

		void h.refresher.ensure();
		await Promise.resolve();
		let done = false;
		const waiting = h.refresher.settled().then(() => (done = true));
		await Promise.resolve();
		expect(done).toBe(false);
		release(fresh('0.0.3'));
		await waiting;
		expect(done).toBe(true);
		expect(h.calls).toBe(1);
	});
});

describe('isNewerVersion', () => {
	it('compares dotted numeric parts, not strings', () => {
		expect(isNewerVersion('0.0.105', '0.0.99')).toBe(true);
		expect(isNewerVersion('0.0.99', '0.0.105')).toBe(false);
		expect(isNewerVersion('0.1.0', '0.0.999')).toBe(true);
		expect(isNewerVersion('1.0', '0.9.9')).toBe(true);
	});

	it('is strict: an equal version is not newer, nor is a shorter spelling of it', () => {
		expect(isNewerVersion('0.0.84', '0.0.84')).toBe(false);
		expect(isNewerVersion('1.0', '1.0.0')).toBe(false);
		expect(isNewerVersion('1.0.0', '1.0')).toBe(false);
	});

	it('never trusts a version it cannot parse, in either position', () => {
		expect(isNewerVersion('0.0.0-unknown', '0.0.1')).toBe(false);
		expect(isNewerVersion('9.9.9', '0.0.0-unknown')).toBe(false);
		expect(isNewerVersion('0.0.100-beta.1', '0.0.99')).toBe(false);
		expect(isNewerVersion('', '0.0.1')).toBe(false);
	});
});

describe('pendingSelfUpdate', () => {
	const cli = (version: string | null, source: AgentCli['source'] = 'fresh'): AgentCli => ({
		binDir: '/cfg/cli/node_modules/.bin',
		version,
		source
	});

	it('names a newer installed version, fresh or last-good', () => {
		expect(pendingSelfUpdate(cli('0.0.105'), '0.0.84')).toBe('0.0.105');
		expect(pendingSelfUpdate(cli('0.0.105', 'stale'), '0.0.84')).toBe('0.0.105');
	});

	it('is null for the ambient PATH, an unreadable version, or nothing newer', () => {
		expect(pendingSelfUpdate(AMBIENT_CLI, '0.0.84')).toBeNull();
		expect(pendingSelfUpdate(cli(null), '0.0.84')).toBeNull();
		expect(pendingSelfUpdate(cli('0.0.84'), '0.0.84')).toBeNull();
		expect(pendingSelfUpdate(cli('0.0.80'), '0.0.84')).toBeNull();
		// A repo checkout under tsx reports 0.0.1; every published release is
		// newer, but that daemon never runs from the prefix, so daemon.ts
		// never asks. The decision itself still says "newer".
		expect(pendingSelfUpdate(cli('0.0.105'), '0.0.1')).toBe('0.0.105');
	});
});

describe('pathWithin', () => {
	it('requires the boundary to fall on a separator', () => {
		expect(pathWithin('/cfg/cli/node_modules/tines/dist/index.js', '/cfg/cli')).toBe(true);
		expect(pathWithin('/cfg/cli/node_modules/tines/dist/index.js', '/cfg/cli/')).toBe(true);
		expect(pathWithin('/cfg/cli-old/node_modules/tines/dist/index.js', '/cfg/cli')).toBe(false);
		expect(pathWithin('/cfg/cli', '/cfg/cli')).toBe(false);
		expect(pathWithin('/opt/homebrew/lib/node_modules/tines/dist/index.js', '/cfg/cli')).toBe(
			false
		);
	});
});

describe('buildSpawnEnv env items', () => {
	it('an empty env override replaces the inherited host value', () => {
		const env = buildSpawnEnv(
			{ EMPTY: 'host value' },
			{
				binDir: null,
				apiKey: 'key',
				apiUrl: 'https://tines.test',
				extra: [{ name: 'EMPTY', value: '' }]
			}
		);
		expect(env).toHaveProperty('EMPTY', '');
	});

	it('merges extra variables but Tines-owned ones and PATH always win', () => {
		const env = buildSpawnEnv(
			{ PATH: '/usr/bin', KEEP: 'base' },
			{
				binDir: '/managed/bin',
				apiKey: 'rk_real',
				apiUrl: 'https://tines.test/',
				extra: [
					{ name: 'GH_TOKEN', value: 'ghp_x' },
					{ name: 'KEEP', value: 'override' },
					{ name: 'TINES_API_KEY', value: 'rk_planted' },
					{ name: 'TINES_API_URL', value: 'https://evil.test' },
					{ name: 'PATH', value: '/evil' }
				]
			}
		);
		expect(env.GH_TOKEN).toBe('ghp_x');
		expect(env.KEEP).toBe('override');
		expect(env.TINES_API_KEY).toBe('rk_real');
		expect(env.TINES_API_URL).toBe('https://tines.test');
		expect(env.PATH).toBe(`/managed/bin${delimiter}/usr/bin`);
	});
});

describe('redactSecrets', () => {
	it('masks each secret and its JSON-escaped form, including short ones', () => {
		const text = 'token=s3cr"et\\n {"text":"s3cr\\"et"} pin=ab ab';
		expect(redactSecrets(text, ['s3cr"et', 'ab'])).toBe('token=***\\n {"text":"***"} pin=*** ***');
	});

	it('is applied by LogBatcher.append when configured', async () => {
		const chunks: string[] = [];
		const batcher = new LogBatcher(
			async (chunk) => {
				chunks.push(chunk);
			},
			{ redact: ['ghp_secretvalue'] }
		);
		batcher.append('GH_TOKEN=ghp_secretvalue exported\n');
		await batcher.flush();
		expect(chunks.join('')).toBe('GH_TOKEN=*** exported\n');
		expect(chunks.join('')).not.toContain('ghp_secretvalue');
	});
});

describe('streaming secret masking', () => {
	it('masks every split of literal and JSON-escaped secrets, including overlapping values', async () => {
		const secrets = ['abc', 'abcdef', 'quote"and\nnewline', 'xy', ''];
		const input = 'before abcdef / quote"and\nnewline / "quote\\"and\\nnewline" / xy after';
		const expected = 'before *** / *** / "***" / *** after';
		for (let split = 0; split <= input.length; split++) {
			const raw = new SecretRedactor(secrets);
			expect(raw.write(input.slice(0, split)) + raw.write(input.slice(split)) + raw.end()).toBe(
				expected
			);
			const chunks: string[] = [];
			const batcher = new LogBatcher(async (chunk) => void chunks.push(chunk), {
				redact: secrets,
				maxBytes: 1
			});
			batcher.append(input.slice(0, split));
			await batcher.flush();
			batcher.append(input.slice(split));
			await batcher.finish();
			expect(chunks.join('')).toBe(expected);
		}
	});

	it('holds a possible secret prefix through flush and releases unmatched final text', async () => {
		const chunks: string[] = [];
		const batcher = new LogBatcher(async (chunk) => void chunks.push(chunk), {
			redact: ['secret']
		});
		batcher.append('value=sec');
		await batcher.flush();
		expect(chunks.join('')).toBe('value=');
		await batcher.finish();
		expect(chunks.join('')).toBe('value=sec');
	});
});
