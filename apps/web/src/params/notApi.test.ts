import { describe, expect, it } from 'vitest';
import { match } from './notApi';

// The catch-all 404 route lives inside (app), whose layout redirects anonymous
// requests to the sign-in page. If the rest parameter ever matched an /api/
// path, a bad API request would answer 302 instead of 404 — so the exclusion
// is the contract worth pinning down.
describe('notApi matcher', () => {
	it.each(['api', 'api/', 'api/v1/no-such-endpoint', 'api/auth/callback'])(
		'excludes %o',
		(path) => {
			expect(match(path)).toBe(false);
		}
	);

	it.each(['nope', 'issues/Demo/1', 'apiary', 'projects/prj_x/api', ''])('accepts %o', (path) => {
		expect(match(path)).toBe(true);
	});
});
