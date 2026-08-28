import { Command, CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import { helpGuard } from './help-guard.js';

/**
 * Mirrors the shape of the two real markdown-body commands (`issues comment`
 * and `journal append`): a <ref> followed by a free-text <markdown> body, with
 * passThroughOptions() so a body may start with "-". Records whether the
 * mutating part of the action ran.
 */
function runComment(argv: string[]): { mutated: string | null; out: string } {
	let mutated: string | null = null;
	let out = '';
	const program = new Command().name('tines').enablePositionalOptions();
	const comment = program
		.command('comment')
		.argument('<ref>')
		.argument('<markdown>')
		.description('Comment on an issue (Markdown body)')
		.passThroughOptions()
		.action((_ref: string, markdown: string, _opts: unknown, command: Command) => {
			if (helpGuard(command, markdown)) return;
			mutated = markdown;
		});
	comment.exitOverride();
	comment.configureOutput({
		writeOut: (str) => {
			out += str;
		},
		writeErr: (str) => {
			out += str;
		}
	});

	try {
		program.parse(argv, { from: 'user' });
	} catch (err) {
		// command.help() exits; exitOverride() turns that into a throw.
		if (!(err instanceof CommanderError) || err.code !== 'commander.help') throw err;
	}
	return { mutated, out };
}

describe('helpGuard', () => {
	it('prints help instead of mutating when the body is exactly --help', () => {
		const { mutated, out } = runComment(['comment', 'Tines/5', '--help']);
		expect(mutated).toBeNull();
		expect(out).toContain('Usage: tines comment [options] <ref> <markdown>');
	});

	it('prints help instead of mutating when the body is exactly -h', () => {
		const { mutated, out } = runComment(['comment', 'Tines/5', '-h']);
		expect(mutated).toBeNull();
		expect(out).toContain('Usage: tines comment [options] <ref> <markdown>');
	});

	it('still passes through a real body that starts with a dash', () => {
		const body = '- 2026-08-28: a dated journal bullet';
		const { mutated, out } = runComment(['comment', 'Tines/5', body]);
		expect(mutated).toBe(body);
		expect(out).toBe('');
	});

	it('only matches an exact --help, not a body that mentions it', () => {
		const body = 'run `tines issues comment --help` for usage';
		const { mutated } = runComment(['comment', 'Tines/5', body]);
		expect(mutated).toBe(body);
	});
});
