/**
 * The resumed-run preamble: the short header that replaces the cold launch
 * preamble when a send-back continues its predecessor's conversation. What
 * matters here is what it does NOT repeat (the session is still holding it)
 * and that the one thing which genuinely differs per environment — how this
 * run's API key reached the agent — is told truthfully for each.
 */
import { describe, expect, it } from 'vitest';
import { buildResumePreamble, buildSupervisorPreamble } from './preamble';

const base = {
	runId: 'arun_new',
	runnerName: 'macbook-claude',
	issueRef: 'Tines/362',
	timeoutMinutes: 30,
	apiUrl: 'https://tines.test',
	repoDirs: ['tines']
};

describe('buildResumePreamble', () => {
	it('names the run it continues and stays out of what the conversation already holds', () => {
		const text = buildResumePreamble({ ...base, variant: 'local', previousRunId: 'arun_prev' });
		expect(text.startsWith('# Supervisor run (resumed)')).toBe(true);
		expect(text).toContain('This is run arun_new on runner "macbook-claude" for issue Tines/362');
		expect(text).toContain('It continues run arun_prev');
		// The cold preamble's workspace tour is exactly what a resumed agent
		// does not need — it is sitting in that workspace.
		const cold = buildSupervisorPreamble({ ...base, variant: 'local' });
		expect(cold).toContain('## Workspace');
		expect(text).not.toContain('## Workspace');
		expect(text.length).toBeLessThan(cold.length);
		// The contract still travels: it is what a transition-less run breaks.
		expect(text).toContain('## The contract');
	});

	it('tells each variant the truth about how its key was replaced', () => {
		const local = buildResumePreamble({ ...base, variant: 'local', previousRunId: 'arun_prev' });
		expect(local).toContain('`TINES_API_KEY` in your environment has been replaced');

		// Managed is not an env swap: the key is rotated inside the vault
		// credential the live session reads, so the preamble says that and
		// says what to do if the session has not picked it up.
		const managed = buildResumePreamble({
			...base,
			variant: 'claude_managed',
			previousRunId: 'arun_prev'
		});
		expect(managed).toContain('the credential');
		expect(managed).toContain('re-read the variable');
		expect(managed).not.toContain('in your environment has been replaced');
	});
});
