/**
 * The dialog's preview must agree with what the server would actually write,
 * so these run against the real `listStarters()` summaries rather than
 * fixtures — a content change in `$lib/server/starters` that breaks the
 * rendering shows up here, while nothing asserts on the prose itself.
 */
import { describe, expect, it } from 'vitest';
import { repoDirFromUrl, type StarterSummary } from '@tines/shared';
import { listStarters } from '$lib/server/api/starters';
import {
	createsLines,
	declaredInputs,
	missingRequired,
	previewVars,
	renderStarter,
	serverVars
} from './starter-preview';

const STARTERS = listStarters();
const byId = (id: string): StarterSummary => {
	const found = STARTERS.find((s) => s.id === id);
	if (!found) throw new Error(`no starter ${id}`);
	return found;
};
const blank = byId('blank');
const code = byId('code');
const plan = byId('plan');

describe('serverVars', () => {
	it('derives repo_name from the URL, exactly as the server does', () => {
		const vars = serverVars(code, { repo_url: 'https://github.com/you/widget.git' }, 'Site');
		expect(vars.repo_url).toBe('https://github.com/you/widget.git');
		expect(vars.repo_name).toBe(repoDirFromUrl('https://github.com/you/widget.git'));
		expect(vars.project).toBe('Site');
	});

	it('renders an absent or blank input as the empty string', () => {
		const vars = serverVars(code, { repo_url: '  ' }, 'Site');
		expect(vars.repo_url).toBe('');
		expect(vars.repo_branch).toBe('');
		// No URL means no derived name — never the literal "repo" fallback.
		expect(vars.repo_name).toBe('');
	});

	it('declares every input the starter declares, and nothing else', () => {
		const vars = serverVars(plan, { brief: 'Q1 hiring', repo_url: 'stale' }, 'Plan');
		expect(vars.brief).toBe('Q1 hiring');
		expect(vars.repo_url).toBeUndefined();
	});
});

describe('previewVars', () => {
	it('shows a blank input as an ellipsis so the preview reads as a sentence', () => {
		expect(previewVars(plan, {}, 'Plan').brief).toBe('…');
		expect(previewVars(plan, { brief: 'Q1 hiring' }, 'Plan').brief).toBe('Q1 hiring');
	});

	it('shows an unnamed project as an ellipsis too', () => {
		expect(previewVars(blank, {}, '   ').project).toBe('…');
	});
});

describe('renderStarter', () => {
	it('caps a long first-issue title at the server limit and preserves newlines', () => {
		const brief = `first line\n${'x'.repeat(1000)}`;
		const preview = renderStarter(plan, { brief }, 'Plan');
		expect(preview.creates.firstIssue?.title).toHaveLength(500);
		expect(preview.creates.firstIssue?.title).toContain('\n');
	});
	it('prefills the conventions template with what the user typed', () => {
		const preview = renderStarter(plan, { brief: 'Q1 hiring' }, 'Plan');
		expect(preview.conventions).toContain('Q1 hiring');
		expect(preview.conventions).not.toContain('{{');
	});

	it('leaves an empty slot in the prefill but an ellipsis in the preview', () => {
		const preview = renderStarter(plan, {}, 'Plan');
		expect(preview.conventions).not.toContain('{{ brief }}');
		expect(preview.creates.firstIssue?.title).toContain('…');
	});

	it('renders context names from the inputs', () => {
		const preview = renderStarter(code, { repo_url: 'https://github.com/you/widget.git' }, 'Site');
		expect(preview.creates.context.map((c) => c.name)).toContain('widget');
	});

	it('caps a context name at the length the server stores', () => {
		// `starterQueries` slices the rendered name to 100 characters, so a very
		// long repo directory must not preview under a name it will never have.
		const url = `https://github.com/you/${'w'.repeat(140)}.git`;
		const name = renderStarter(code, { repo_url: url }, 'Site').creates.context[0].name;
		expect(name).toHaveLength(100);
		expect(repoDirFromUrl(url).startsWith(name)).toBe(true);
	});

	it('has no conventions template for blank', () => {
		const preview = renderStarter(blank, {}, 'Anything');
		expect(preview.conventions).toBeNull();
		expect(preview.creates.workflows).toEqual([]);
		expect(preview.creates.firstIssue).toBeNull();
	});
});

describe('missingRequired', () => {
	it('names a required input that is blank or whitespace', () => {
		expect(missingRequired(code, {}).map((s) => s.key)).toEqual(['repo_url']);
		expect(missingRequired(code, { repo_url: '   ' }).map((s) => s.key)).toEqual(['repo_url']);
	});

	it('is empty once the required inputs are filled', () => {
		expect(missingRequired(code, { repo_url: 'https://x/y.git' })).toEqual([]);
		expect(missingRequired(blank, {})).toEqual([]);
	});

	it('ignores optional inputs', () => {
		expect(missingRequired(code, { repo_url: 'x' }).map((s) => s.key)).not.toContain('repo_branch');
	});
});

describe('declaredInputs', () => {
	it('trims, fills absent optionals, and drops a key from another starter', () => {
		expect(declaredInputs(code, { repo_url: '  u  ', brief: 'stale' })).toEqual({
			repo_url: 'u',
			repo_branch: ''
		});
	});

	it('is empty for a starter that declares nothing', () => {
		expect(declaredInputs(blank, { repo_url: 'x' })).toEqual({});
	});
});

describe('createsLines', () => {
	it('marks only the default workflow and lists its states', () => {
		const lines = createsLines(renderStarter(plan, { brief: 'b' }, 'P'), false);
		const workflowLines = lines.filter((l) => l.startsWith('Workflow'));
		expect(workflowLines.filter((l) => l.includes('(default)'))).toHaveLength(1);
		expect(workflowLines.some((l) => l.includes('→'))).toBe(true);
	});

	it('adds the conventions prompt only when there is one to add', () => {
		const preview = renderStarter(code, { repo_url: 'https://x/widget.git' }, 'P');
		expect(createsLines(preview, true)).toContain('Prompt “conventions”');
		expect(createsLines(preview, false)).not.toContain('Prompt “conventions”');
	});

	it('names context items by kind and the first issue by state', () => {
		const lines = createsLines(
			renderStarter(code, { repo_url: 'https://github.com/you/widget.git' }, 'P'),
			true
		);
		expect(lines).toContain('Repository “widget”');
		expect(lines.some((l) => l.startsWith('Issue “') && l.includes('('))).toBe(true);
	});

	it('is empty for blank with no conventions', () => {
		expect(createsLines(renderStarter(blank, {}, 'P'), false)).toEqual([]);
		expect(createsLines(renderStarter(blank, {}, 'P'), true)).toEqual(['Prompt “conventions”']);
	});
});
