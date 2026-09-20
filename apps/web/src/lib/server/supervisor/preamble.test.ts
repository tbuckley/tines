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
	repoDirs: ['tines'],
	skills: [
		{ name: 'review-checklist', description: ' Check the\n implementation   before review. ' },
		{ name: 'blank-skill', description: '   ' }
	]
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
		expect(text).toContain('current effective set of 2 skills replaces the prior attachment set');
		expect(text).toContain('refreshed at `.agents/skills`');
		expect(text).not.toContain('review-checklist');
		// The contract still travels: it is what a transition-less run breaks.
		expect(text).toContain('## The contract');
	});

	it('makes an empty current set explicit for both delivery variants', () => {
		for (const variant of ['local', 'claude_managed'] as const) {
			const text = buildResumePreamble({
				...base,
				variant,
				skills: [],
				previousRunId: 'arun_prev'
			});
			expect(text).toContain('No skills are currently attached');
			expect(text).toContain('prior');
		}
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

describe('buildSupervisorPreamble skill delivery', () => {
	it('uses the canonical directory and a count-only local recovery cue', () => {
		const text = buildSupervisorPreamble({ ...base, variant: 'local' });
		expect(text).toContain('`.agents/skills/<name>/…`');
		expect(text).toContain('2 skills are attached at `.agents/skills`');
		expect(text).toContain('tines issues context Tines/362 --json');
		expect(text).not.toContain('review-checklist');
		expect(text).not.toContain('Check the implementation');
	});

	it('renders normalized managed metadata once with a blank-description fallback', () => {
		const text = buildSupervisorPreamble({ ...base, variant: 'claude_managed' });
		expect(
			text.match(/`review-checklist`: Check the implementation before review\./g)
		).toHaveLength(1);
		expect(text).toContain('`blank-skill`: use when the blank-skill procedure is relevant.');
		expect(text).toContain('tines issues context Tines/362 --json');
		expect(text).toContain('not automatically seeded');
	});
});

describe('buildSupervisorPreamble env delivery (managed)', () => {
	it('renders public values as single-quoted export lines and names secrets without values', () => {
		const text = buildSupervisorPreamble({
			...base,
			variant: 'claude_managed',
			envExports: [
				{ name: 'NPM_REGISTRY', value: 'https://r.example' },
				{ name: 'GREETING', value: "it's $HOME `here`" }
			],
			envSecretNames: ['GH_TOKEN']
		});
		expect(text).toContain("`export NPM_REGISTRY='https://r.example'`");
		// A quote inside the value closes, escapes and reopens the literal; $ and
		// backticks stay inert inside single quotes.
		expect(text).toContain("`export GREETING='it'\\''s $HOME `here`'`");
		expect(text).toContain('Secret environment variables (`GH_TOKEN`) are vault credentials');
		expect(text.indexOf('Also exported for this run')).toBeGreaterThan(
			text.indexOf('## Workspace')
		);
	});

	it('adds nothing when there are no env items', () => {
		const bare = buildSupervisorPreamble({ ...base, variant: 'claude_managed' });
		const empty = buildSupervisorPreamble({
			...base,
			variant: 'claude_managed',
			envExports: [],
			envSecretNames: []
		});
		expect(empty).toBe(bare);
		expect(bare).not.toContain('`export ');
		expect(bare).not.toContain('vault credentials');
	});
});
