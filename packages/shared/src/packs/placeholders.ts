/**
 * Pack placeholders (specs/packs/MVP_SPEC.md, "Placeholders").
 *
 * The only placeholder is `{{ inputs.<name> }}`, where `<name>` is an input
 * name (`[a-z][a-z0-9_]{0,62}`) and spaces or tabs are optional on either
 * side of `inputs.<name>`. The grammar is strict: anything else in double
 * braces — `{{ date }}`, `{{ inputs }}`, `{{inputs.Foo}}`, `{{ inputs.a-b }}`,
 * or a placeholder split across lines — is literal text and passes through
 * unchanged, so a skill documenting another templating language needs no
 * escaping.
 *
 * One or more `!` straight after the opening braces escapes a placeholder:
 * the renderer removes one `!` (`{{! inputs.x }}` → `{{ inputs.x }}`,
 * `{{!! inputs.x }}` → `{{! inputs.x }}`), and an escaped placeholder is
 * neither reported nor checked.
 */

const PLACEHOLDER = /\{\{(!*)([ \t]*inputs\.([a-z][a-z0-9_]{0,62})[ \t]*\}\})/g;

/** The input names `text` references, unique, in first-seen order. Escaped placeholders are skipped. */
export function scanPlaceholders(text: string): string[] {
	const names: string[] = [];
	for (const m of text.matchAll(PLACEHOLDER)) {
		if (m[1] !== '') continue;
		if (!names.includes(m[3])) names.push(m[3]);
	}
	return names;
}

/**
 * Renders placeholders with `resolve`. A name it returns `undefined` for is
 * left in the output as written and reported in `missing` (unique, in
 * first-seen order). Escaped placeholders lose one `!`.
 */
export function renderPlaceholders(
	text: string,
	resolve: (name: string) => string | undefined
): { text: string; missing: string[] } {
	const missing: string[] = [];
	const out = text.replace(PLACEHOLDER, (whole, bangs: string, rest: string, name: string) => {
		if (bangs !== '') return `{{${bangs.slice(1)}${rest}`;
		const value = resolve(name);
		if (value === undefined) {
			if (!missing.includes(name)) missing.push(name);
			return whole;
		}
		return value;
	});
	return { text: out, missing };
}

/** Single-quotes a shell word unless it is plainly safe as is. */
function shellQuote(word: string): string {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(word)) return word;
	return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * What a `workflow` input renders as: one line naming the workflow, its start
 * state and the command to file into it. The project and state names are
 * shell-quoted when they need it.
 */
export function describeWorkflowInput(opts: {
	workflowName: string;
	stateName: string;
	workflowId: string;
	projectName: string;
}): string {
	const { workflowName, stateName, workflowId, projectName } = opts;
	return (
		`the "${workflowName}" workflow, starting in "${stateName}" — file with ` +
		`\`tines issues create ${shellQuote(projectName)} -w ${shellQuote(workflowId)} -s ${shellQuote(stateName)} -t "<title>"\``
	);
}
