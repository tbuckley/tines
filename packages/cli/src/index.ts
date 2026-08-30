import { program, reportError } from './program.js';

try {
	await program.parseAsync();
} catch (err) {
	reportError(err);
}
