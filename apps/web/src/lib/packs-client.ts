/**
 * Browser helpers for the packs pages: turning a picked `.tinespack` file or
 * folder into an upload, and calling the packs API.
 */
import {
	PACK_ARCHIVE_EXTENSION,
	renderPlaceholders,
	type PackInputValueInput,
	type PackInputView,
	type PackUpload,
	type PackWireFile
} from '@tines/shared';

export function bytesToB64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/**
 * A picked archive (one `.tinespack`/`.zip`), or a picked folder (many files
 * with `webkitRelativePath`): the folder's own name is stripped by the server
 * as the single top-level folder.
 */
export async function uploadFromFiles(files: FileList | File[]): Promise<PackUpload> {
	const list = [...files];
	if (
		list.length === 1 &&
		!list[0].webkitRelativePath &&
		(list[0].name.endsWith(PACK_ARCHIVE_EXTENSION) || list[0].name.endsWith('.zip'))
	)
		return { archive_b64: bytesToB64(new Uint8Array(await list[0].arrayBuffer())) };
	const wire: PackWireFile[] = [];
	for (const f of list)
		wire.push({
			path: f.webkitRelativePath || f.name,
			content_b64: bytesToB64(new Uint8Array(await f.arrayBuffer()))
		});
	return { files: wire };
}

export class PackApiError extends Error {
	constructor(
		message: string,
		readonly code: string | null,
		readonly details: Record<string, unknown> | null
	) {
		super(message);
	}
}

export async function packApi<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
	const response = await fetch(path, {
		method,
		headers: body === undefined ? {} : { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const value = response.status === 204 ? null : await response.json().catch(() => null);
	if (!response.ok)
		throw new PackApiError(
			value?.error?.message ?? `Request failed (${response.status})`,
			value?.error?.code ?? null,
			value?.error?.details ?? null
		);
	return value as T;
}

/** Form state for one input, as the inputs form edits it. */
export interface InputDraft {
	text: string;
	repo_url: string;
	repo_branch: string;
	workflow: string;
	secret: string;
}

export function draftFor(view: PackInputView): InputDraft {
	const d: InputDraft = { text: '', repo_url: '', repo_branch: '', workflow: '', secret: '' };
	const v = view.value;
	if (v?.type === 'text') d.text = v.text;
	else if (v?.type === 'repo') {
		d.repo_url = v.repo_url;
		d.repo_branch = v.repo_branch ?? '';
	} else if (v?.type === 'workflow' && v.workflow_id)
		d.workflow = v.state_id ? `${v.workflow_id}|${v.state_id}` : v.workflow_id;
	if (!v) {
		if (view.decl.type === 'text' && view.decl.default !== undefined) d.text = view.decl.default;
		if (view.decl.type === 'repo') d.repo_branch = view.decl.default_branch ?? '';
		if (view.decl.type === 'workflow' && view.decl.default)
			d.workflow = `pack:${view.decl.default}`;
	}
	return d;
}

/** The wire value for a draft, or undefined to leave the input as it is. */
export function valueFromDraft(
	view: PackInputView,
	d: InputDraft
): PackInputValueInput | null | undefined {
	switch (view.decl.type) {
		case 'text':
			// Empty clears the value (a default or `required: false` then applies).
			return d.text === '' ? null : { text: d.text };
		case 'repo':
			return d.repo_url.trim()
				? { repo_url: d.repo_url.trim(), repo_branch: d.repo_branch.trim() || null }
				: undefined;
		case 'workflow': {
			if (!d.workflow) return undefined;
			if (d.workflow.startsWith('pack:')) return { workflow_id: d.workflow };
			const [workflow_id, state_id] = d.workflow.split('|');
			return { workflow_id, state_id: state_id ?? null };
		}
		default:
			return undefined;
	}
}

/**
 * Renders a template with the values typed into the form, for previews. A
 * workflow input previews as its chosen label; the server renders the real line.
 */
export function previewText(
	text: string,
	views: PackInputView[],
	drafts: Record<string, InputDraft>,
	workflowLabel: (ref: string) => string
): string {
	return renderPlaceholders(text, (name) => {
		const view = views.find((v) => v.name === name);
		const d = drafts[name];
		if (!view || !d) return undefined;
		switch (view.decl.type) {
			case 'text':
				return d.text || (view.decl.required === false ? '' : undefined);
			case 'repo':
				return d.repo_url || undefined;
			case 'workflow':
				return d.workflow ? `the "${workflowLabel(d.workflow)}" workflow` : undefined;
			default:
				return undefined;
		}
	}).text;
}

export function browserTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
}

/** The placeholder that reads an input. */
export function placeholderFor(name: string): string {
	return `{{ inputs.${name} }}`;
}

/**
 * `value` with `text` inserted at the field's cursor (or appended), and where
 * the cursor lands after it.
 */
export function insertAtCursor(
	value: string,
	text: string,
	field: HTMLInputElement | HTMLTextAreaElement | null | undefined
): { value: string; cursor: number } {
	const start = field?.selectionStart ?? value.length;
	const end = field?.selectionEnd ?? start;
	return { value: value.slice(0, start) + text + value.slice(end), cursor: start + text.length };
}

/**
 * A pack skill's `SKILL.md`: frontmatter naming the skill and describing it
 * (the pack format requires both, and the name must match the skill's), then
 * the instructions.
 */
export function skillMarkdown(name: string, description: string, body: string): string {
	return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.replace(/^\n+/, '')}`;
}

/** The instructions of a `SKILL.md`, without its frontmatter. */
export function skillBody(markdown: string): string {
	const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
	return (m ? markdown.slice(m[0].length) : markdown).replace(/^\n+/, '');
}
