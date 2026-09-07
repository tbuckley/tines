/**
 * The Now row's `fix:` lines name commands an operator pastes (Tines/256), so
 * every `tines …` one of them prints is checked against the real command tree:
 * the path has to resolve to a registered command, and every `--flag` has to be
 * an option that command declares. A renamed subcommand or a dropped flag reds
 * here instead of printing a help dump at whoever is unblocking their fleet.
 */
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import type { QueueBinding, QueueGroup, QueueVerdict } from '@tines/shared';
import { queueFix, queueHeadline } from './commands/supervisor.js';
import { program } from './program.js';

/** Every node of the tree, as `tines issues comment` style paths. */
function commandPaths(root: Command): Map<string, Command> {
	const out = new Map<string, Command>();
	const walk = (cmd: Command, prefix: string[]) => {
		const path = [...prefix, cmd.name()];
		out.set(path.join(' '), cmd);
		for (const sub of cmd.commands) walk(sub as Command, path);
	};
	walk(root, []);
	return out;
}

/** The `tines …` citations in a fix line: the command path plus its flags. */
export function citedCommands(text: string): { path: string; flags: string[] }[] {
	const out: { path: string; flags: string[] }[] = [];
	const tokens = text.split(/\s+/);
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] !== 'tines') continue;
		const words: string[] = ['tines'];
		const flags: string[] = [];
		let inArgs = false;
		for (let j = i + 1; j < tokens.length; j++) {
			const raw = tokens[j];
			const token = raw.replace(/[,.;:)]+$/, '');
			if (token.startsWith('--')) {
				flags.push(token);
				inArgs = true;
			} else if (token.startsWith('<') || token.startsWith('[')) {
				inArgs = true; // a placeholder; the path ended
			} else if (/^[a-z][a-z-]*$/.test(token) && !inArgs) {
				words.push(token);
			} else {
				break; // prose resumed
			}
			i = j;
			if (token !== raw) break; // punctuation closed the citation
		}
		out.push({ path: words.join(' '), flags });
	}
	return out;
}

const BINDINGS: Record<string, QueueBinding> = {
	max_concurrent: {
		kind: 'max_concurrent',
		runner_id: 'rnr_1',
		runner_name: 'macbook-claude',
		current: 3,
		limit: 3
	},
	global_cap: { kind: 'global_cap', current: 4, limit: 4 },
	state_roster: {
		kind: 'state_roster',
		state_id: 'wfs_impl',
		current: 2,
		limit: 2,
		overridden: true
	}
};

const VERDICTS = [
	'ok',
	'at_capacity',
	'quota_exhausted',
	'offline',
	'paused',
	'draining',
	'backing_off',
	'no_rule',
	'ambiguous_rule',
	'no_targets',
	'rate_limited',
	'pin_missing',
	'automation_off',
	'parked'
] as const satisfies readonly QueueVerdict[];
// Fails to compile if a new verdict is added without a case here.
const _exhaustive: [Exclude<QueueVerdict, (typeof VERDICTS)[number]>] extends [never]
	? true
	: false = true;
void _exhaustive;

/**
 * The fixture's runner name is deliberately capitalised: `citedCommands` reads
 * a path lexically, so a lowercase name interpolated after a subcommand would
 * be indistinguishable from a further subcommand and would be checked as part
 * of the path. A capital tells the parser the path ended.
 */
const RUNNER_NAME = 'Runner-One';

/** Every block `supervisor status` can print: each verdict, under each binding. */
function everyBlock() {
	const blocks: { verdict: QueueVerdict; binding: QueueBinding | null }[] = [];
	for (const verdict of VERDICTS) {
		blocks.push({ verdict, binding: null });
		for (const binding of Object.values(BINDINGS)) blocks.push({ verdict, binding });
	}
	return blocks.map(({ verdict, binding }) => ({
		verdict,
		runnerName: RUNNER_NAME,
		binding,
		count: 2,
		groups: [] as QueueGroup[]
	}));
}

describe('queueFix', () => {
	const paths = commandPaths(program);

	it('only names commands the CLI actually has', () => {
		const cited = everyBlock().flatMap((block) => citedCommands(queueFix(block) ?? ''));
		expect(cited.length).toBeGreaterThan(0);
		for (const { path, flags } of cited) {
			const cmd = paths.get(path);
			expect(cmd, `${path} is not a command`).toBeDefined();
			for (const flag of flags) {
				const known = cmd!.options.some((o) => o.long === flag);
				expect(known, `${path} has no ${flag}`).toBe(true);
			}
		}
	});

	it('offers a remedy for every verdict that has one, and none for the rest', () => {
		const fixes = new Map<QueueVerdict, string | null>();
		for (const verdict of VERDICTS) {
			fixes.set(verdict, queueFix({ ...everyBlock()[0], verdict, binding: null }));
		}
		// `ok` is already dispatching and `parked` / `draining` are their own
		// surfaces; everything else names a knob.
		expect([...fixes].filter(([, fix]) => fix === null).map(([v]) => v)).toEqual([
			'ok',
			'draining',
			'parked'
		]);
	});

	it('names the daemon flag for at_capacity, since no CLI command sets max_concurrent', () => {
		const fix = queueFix({ ...everyBlock()[0], verdict: 'at_capacity', binding: null });
		expect(fix).toContain('tines runner daemon --max-concurrent N');
		expect(fix).toContain(RUNNER_NAME);
	});

	it('warns that the roster remedy replaces the whole roster', () => {
		const fix = queueFix({
			...everyBlock()[0],
			verdict: 'quota_exhausted',
			binding: BINDINGS.state_roster
		});
		expect(fix).toContain('tines supervisor quota roster --default <n>');
		expect(fix).toContain('replaces the whole roster');
	});

	it('resumes a paused runner through the plural registry group', () => {
		expect(queueFix({ ...everyBlock()[0], verdict: 'paused', binding: null })).toBe(
			`tines runners resume ${RUNNER_NAME}`
		);
	});

	it('has a headline for every verdict', () => {
		for (const block of everyBlock()) {
			expect(queueHeadline(block), block.verdict).toBeTruthy();
		}
	});
});

describe('citedCommands', () => {
	it('reads the path and its flags out of a prose line', () => {
		expect(
			citedCommands('raise the cap — restart with tines runner daemon --max-concurrent N, or edit')
		).toEqual([{ path: 'tines runner daemon', flags: ['--max-concurrent'] }]);
	});

	it('ends the citation at punctuation, not at the end of the sentence', () => {
		expect(citedCommands('tines routing list, then edit the rule')).toEqual([
			{ path: 'tines routing list', flags: [] }
		]);
	});

	it('stops the path at a placeholder and finds both citations', () => {
		expect(
			citedCommands('tines supervisor quota global <n> — or tines supervisor quota roster')
		).toEqual([
			{ path: 'tines supervisor quota global', flags: [] },
			{ path: 'tines supervisor quota roster', flags: [] }
		]);
	});
});
