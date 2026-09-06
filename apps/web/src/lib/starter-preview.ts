/**
 * What the New-project dialog can say about a starter before it is applied
 * (Tines/249).
 *
 * The dialog prefills the conventions textarea and previews what the project
 * will contain, so both have to be rendered with *the server's* variable set
 * — `starterQueries` in `$lib/server/api/starters.ts` builds
 * `{ ...inputs, project, repo_name }` and renders every template with it.
 * This module is pure (no Svelte, no `$lib/server`) so it can be unit-tested
 * against the real `listStarters()` summaries and stays content-agnostic:
 * every label, hint and line comes from the summary, never from a hardcoded
 * starter id.
 */
import {
	renderTemplate,
	repoDirFromUrl,
	type ContextKind,
	type StarterInputSpec,
	type StarterSummary
} from '@tines/shared';

/** Blank inputs preview as this, so a half-filled form reads as a sentence. */
const BLANK = '…';

/** The value the user typed for a declared input, trimmed; `''` when absent. */
function typed(inputs: Record<string, string>, key: string): string {
	return (inputs[key] ?? '').trim();
}

/**
 * The server's exact variable set (`starters.ts`), so a rendered template
 * equals what `createProject` would have stored. Absent inputs render as `''`
 * — the same as an optional input the user left alone.
 */
export function serverVars(
	starter: StarterSummary,
	inputs: Record<string, string>,
	projectName: string
): Record<string, string> {
	const vars: Record<string, string> = {};
	for (const spec of starter.inputs) vars[spec.key] = typed(inputs, spec.key);
	vars.project = projectName;
	vars.repo_name = vars.repo_url ? repoDirFromUrl(vars.repo_url) : '';
	return vars;
}

/**
 * The same set for the "This creates:" list, but a blank renders as `…` — an
 * unfilled brief should preview as `Scout candidates for …`, not as a title
 * with a hole in it.
 */
export function previewVars(
	starter: StarterSummary,
	inputs: Record<string, string>,
	projectName: string
): Record<string, string> {
	const vars = serverVars(starter, inputs, projectName);
	for (const key of Object.keys(vars)) if (vars[key] === '') vars[key] = BLANK;
	if (!projectName.trim()) vars.project = BLANK;
	return vars;
}

export interface StarterPreview {
	/** The rendered conventions template, or null when the starter has none. */
	conventions: string | null;
	creates: {
		workflows: { name: string; default: boolean; states: string[] }[];
		context: { kind: ContextKind; name: string }[];
		firstIssue: { title: string; workflow: string; state: string } | null;
	};
}

/** Everything the dialog renders about the selected starter. */
export function renderStarter(
	starter: StarterSummary,
	inputs: Record<string, string>,
	projectName: string
): StarterPreview {
	const forServer = serverVars(starter, inputs, projectName);
	const forPreview = previewVars(starter, inputs, projectName);
	const issue = starter.creates.first_issue;
	return {
		conventions: starter.conventions_template
			? renderTemplate(starter.conventions_template, forServer)
			: null,
		creates: {
			workflows: starter.creates.workflows,
			context: starter.creates.context.map((c) => ({
				kind: c.kind,
				name: renderTemplate(c.name, forPreview)
			})),
			firstIssue: issue
				? {
						title: renderTemplate(issue.title, forPreview),
						workflow: issue.workflow,
						state: issue.state
					}
				: null
		}
	};
}

/** Declared inputs the user still has to fill: required and blank after trim. */
export function missingRequired(
	starter: StarterSummary,
	inputs: Record<string, string>
): StarterInputSpec[] {
	return starter.inputs.filter((spec) => spec.required && typed(inputs, spec.key) === '');
}

/**
 * Only the selected starter's declared keys, trimmed. The dialog keeps what
 * the user typed when they switch starters (so switching back restores it),
 * which means the raw state can hold a key the new starter does not declare —
 * and the server 422s `unknown_starter_input` on exactly that.
 */
export function declaredInputs(
	starter: StarterSummary,
	inputs: Record<string, string>
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const spec of starter.inputs) out[spec.key] = typed(inputs, spec.key);
	return out;
}

/** Display noun for a context kind, for the "This creates:" list. */
function kindNoun(kind: ContextKind): string {
	if (kind === 'repo') return 'Repository';
	if (kind === 'prompt') return 'Prompt';
	return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/**
 * The "This creates:" lines, in the order `createProject` inserts them:
 * workflows, the conventions prompt, the rest of the context, the first
 * issue. The conventions line is added *here* rather than coming from the
 * summary — `creates.context` deliberately omits it because `createProject`
 * seeds it itself, and only when there is a body to seed.
 */
export function createsLines(preview: StarterPreview, conventionsPresent: boolean): string[] {
	const lines: string[] = [];
	for (const wf of preview.creates.workflows) {
		lines.push(`Workflow “${wf.name}”${wf.default ? ' (default)' : ''}: ${wf.states.join(' → ')}`);
	}
	if (conventionsPresent) lines.push('Prompt “conventions”');
	for (const item of preview.creates.context) {
		lines.push(`${kindNoun(item.kind)} “${item.name}”`);
	}
	const issue = preview.creates.firstIssue;
	if (issue) lines.push(`Issue “${issue.title}” in ${issue.state} (${issue.workflow})`);
	return lines;
}
