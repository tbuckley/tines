/**
 * The command tree, assembled. Each noun registers itself from
 * `commands/<noun>.ts`; the order of the calls below is the order root `--help`
 * lists them in. `index.ts` is the bin that parses it.
 */
import { readFileSync } from 'node:fs';
import { register as registerContext } from './commands/context.js';
import { register as registerIssues } from './commands/issues.js';
import { register as registerJournal } from './commands/journal.js';
import { registerEvents, registerTime } from './commands/misc.js';
import { register as registerProjects } from './commands/projects.js';
import { register as registerRouting } from './commands/routing.js';
import { register as registerRunners } from './commands/runners.js';
import { register as registerSchedules } from './commands/schedules.js';
import { register as registerSupervisor } from './commands/supervisor.js';
import { register as registerWorkflows } from './commands/workflows.js';
import { reportError } from './common.js';
import { Command } from 'commander';

/**
 * The published version, read from the package manifest rather than hardcoded.
 * CI stamps the patch number into that manifest at publish time (see
 * .github/workflows/publish-cli.yml), so a literal here would always lie —
 * and `tines --version` is how you tell an installed CLI apart from the repo.
 * `../package.json` resolves for both layouts: src/index.ts under tsx, and
 * dist/index.js in the published tarball.
 */
function cliVersion(): string {
	try {
		const manifest = new URL('../package.json', import.meta.url);
		return JSON.parse(readFileSync(manifest, 'utf8')).version ?? '0.0.0-unknown';
	} catch {
		return '0.0.0-unknown';
	}
}

const program = new Command();
// Positional options let markdown-taking commands (comment, journal append)
// accept bodies that start with "-" — e.g. the dated bullets the launch
// prompt teaches — via passThroughOptions().
program.name('tines').description('CLI for Tines').version(cliVersion()).enablePositionalOptions();

registerTime(program);
registerProjects(program);
registerWorkflows(program);
registerIssues(program);
registerContext(program);
registerJournal(program);
registerSchedules(program);
registerRunners(program);
registerRouting(program);
registerSupervisor(program);
registerEvents(program);

export { program, reportError };
