import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it('ships usage JSON and forwards workflow narrowing to the API', async () => {
	vi.stubEnv('TINES_API_URL', 'https://usage.example.test');
	vi.stubEnv('TINES_API_KEY', 'test-key');
	const report = {
		from: 1,
		to: 2,
		generated_at: 2,
		timezone: 'UTC',
		timezone_source: 'utc_fallback',
		accounting_basis: 'finalized_by_ended_at_v1',
		attribution_basis: 'current_issue_project_start_state_workflow_v1',
		filters: { workflow: 'unknown' },
		by: 'workflow',
		scope_total: {},
		matching_total: {},
		groups: [],
		workflow_options: [],
		pending: { scope_count: 0, matching_count: 0, unapplied_filters: [] },
		evidence_filters: {}
	};
	const fetchMock = vi.fn(
		async (_input: string | URL | Request) =>
			new Response(JSON.stringify(report), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
	);
	vi.stubGlobal('fetch', fetchMock);
	const log = vi.spyOn(console, 'log').mockImplementation((..._args: unknown[]) => undefined);
	vi.resetModules();
	const { program } = await import('./program.js');
	await program.parseAsync(['node', 'tines', 'usage', '--workflow', 'unknown', '--json']);

	expect(fetchMock).toHaveBeenCalledOnce();
	expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v1/usage?');
	expect(String(fetchMock.mock.calls[0][0])).toContain('workflow=unknown');
	expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual(report);
});
