import type { Command } from 'commander';

/**
 * Guards markdown-body commands (comment, journal append) against the
 * --help footgun: passThroughOptions() makes commander swallow a trailing
 * --help/-h as the literal <markdown> value instead of parsing it as an
 * option, so it must be checked for manually before mutating anything.
 * Returns true (and prints help) if the guard fired; callers should return.
 */
export function helpGuard(command: Command, markdown: string): boolean {
	if (markdown === '--help' || markdown === '-h') {
		command.help();
		return true;
	}
	return false;
}
