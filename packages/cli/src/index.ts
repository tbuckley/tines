import { program, reportError } from './program.js';

// No top-level await: the single-file CommonJS build (dist/tines.cjs, seeded
// into sandboxes) shares this entry, and CommonJS has none.
program.parseAsync().catch(reportError);
