/**
 * The command tree, assembled. Each noun registers itself from
 * `commands/<noun>.ts`; the order of the calls below is the order root `--help`
 * lists them in. `index.ts` is the bin that parses it.
 */
import { Command } from 'commander';
import { register as registerContext } from './commands/context.js';
import { register as registerIssues } from './commands/issues.js';
import { register as registerJournal } from './commands/journal.js';
import { register as registerLogin } from './commands/login.js';
import { registerEvents, registerTime } from './commands/misc.js';
import { register as registerProjects } from './commands/projects.js';
import { register as registerRouting } from './commands/routing.js';
import { register as registerRunners } from './commands/runners.js';
import { register as registerSchedules } from './commands/schedules.js';
import { register as registerSupervisor } from './commands/supervisor.js';
import { register as registerWorkflows } from './commands/workflows.js';
import { reportError } from './common.js';
import { cliVersion } from './version.js';

const program = new Command();
// Positional options let markdown-taking commands (comment, journal append)
// accept bodies that start with "-" — e.g. the dated bullets the launch
// prompt teaches — via passThroughOptions().
program.name('tines').description('CLI for Tines').version(cliVersion()).enablePositionalOptions();

registerTime(program);
registerLogin(program);
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
