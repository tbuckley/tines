import { describe, expect, it } from 'vitest';
import { requirementFix, type RequirementFixInput } from './requirements.js';

const check = (over: Partial<RequirementFixInput> = {}): RequirementFixInput => ({
	artifact: 'design-doc',
	status: 'missing',
	current_version: null,
	current_type: null,
	...over
});

const version = { version: 2, created_at: 5 };

describe('requirementFix', () => {
	it('renders the one-line positional source a declared type implies', () => {
		// Typed gates carry the shape the CLI can read off the gate itself
		// (Tines/274): one command, no flag, copy-pastable whole.
		const sourceFor = (over: Partial<RequirementFixInput>) =>
			requirementFix(check(over), 'demo/1').command;
		expect(sourceFor({ type: 'file' })).toBe(
			'tines issues artifacts attach demo/1 design-doc <path>'
		);
		expect(sourceFor({ type: 'folder' })).toBe(
			'tines issues artifacts attach demo/1 design-doc <dir>'
		);
		expect(sourceFor({ type: 'link' })).toBe(
			'tines issues artifacts attach demo/1 design-doc <url>'
		);
		expect(sourceFor({ type: 'pr' })).toBe(
			'tines issues artifacts attach demo/1 design-doc <owner/repo#N>'
		);
		// A text gate with no concrete content type still names a path: the
		// gate types it, the extension does not.
		expect(sourceFor({ type: 'text' })).toBe(
			'tines issues artifacts attach demo/1 design-doc <path>'
		);
		for (const type of ['file', 'folder', 'link', 'pr', 'text'] as const) {
			expect(sourceFor({ type })).not.toContain('--');
		}
	});

	it('keeps a flag form when the requirement declares no type', () => {
		// Nothing types a positional source here — the CLI's shape-only
		// inference never guesses text — so the flag has to say it.
		// --file is the least surprising default and the one the old server used.
		expect(requirementFix(check(), 'demo/1').command).toBe(
			'tines issues artifacts attach demo/1 design-doc --file <path>'
		);
		expect(
			requirementFix(
				check({ status: 'satisfied', current_type: 'text', current_version: version }),
				'demo/1'
			).command
		).toBe('tines issues artifacts attach demo/1 design-doc --text <markdown|@file>');
		expect(
			requirementFix(
				check({ status: 'satisfied', current_type: 'link', current_version: version }),
				'demo/1'
			).command
		).toContain('--link <url>');
	});

	it('names --link, never --url, for a link slot', () => {
		// `-u, --url` is the API base URL on every CLI command: an agent that
		// copied it here would attach a link to the API itself (Tines/92).
		expect(requirementFix(check({ type: 'link' }), 'demo/1').command).not.toContain('--url');
	});

	it('turns a concrete content type into a concrete filename', () => {
		expect(
			requirementFix(check({ type: 'text', content_type: 'text/markdown' }), 'demo/1')
		).toEqual({
			kind: 'attach',
			command: 'tines issues artifacts attach demo/1 design-doc design-doc.md'
		});
		expect(
			requirementFix(check({ type: 'text', content_type: 'text/plain' }), 'demo/1').command
		).toBe('tines issues artifacts attach demo/1 design-doc design-doc.txt');
		// A prefix gate names no single file, so the generic path stands.
		expect(requirementFix(check({ type: 'text', content_type: 'text/' }), 'demo/1').command).toBe(
			'tines issues artifacts attach demo/1 design-doc <path>'
		);
		// The filename follows the slot, not the type.
		expect(
			requirementFix(
				check({ artifact: 'review-notes', type: 'text', content_type: 'text/markdown' }),
				'demo/1'
			).command
		).toContain('review-notes review-notes.md');
	});

	it('offers reaffirm as a separate command when the content is merely stale', () => {
		// The slot passed the type checks, so the new version keeps the slot's
		// own type — --text, not the untyped requirement's --file default.
		const fix = requirementFix(
			check({ status: 'stale', current_type: 'text', current_version: version }),
			'demo/1'
		);
		expect(fix.kind).toBe('reattach_or_reaffirm');
		expect(fix.command).toBe(
			'tines issues artifacts attach demo/1 design-doc --text <markdown|@file>'
		);
		expect(fix.alternative).toBe('tines issues artifacts reaffirm demo/1 design-doc');
		// The primary command runs on its own: no prose, no second command
		// glued on, so copying it verbatim cannot fail arity (Tines/255).
		expect(fix.command).not.toContain('reaffirm');
		expect(fix.command).not.toContain(' — ');
	});

	it('renders a stale typed gate as a runnable positional attach', () => {
		const fix = requirementFix(
			check({
				status: 'stale',
				type: 'text',
				content_type: 'text/markdown',
				current_type: 'text',
				current_version: version
			}),
			'demo/1'
		);
		expect(fix.command).toBe('tines issues artifacts attach demo/1 design-doc design-doc.md');
		expect(fix.alternative).toBe('tines issues artifacts reaffirm demo/1 design-doc');
	});

	it('leaves the alternative unset when there is only one way through', () => {
		for (const over of [
			{},
			{ type: 'text' as const, content_type: 'text/markdown' },
			{
				status: 'type_mismatch' as const,
				type: 'text' as const,
				current_type: 'link' as const,
				current_version: version
			}
		]) {
			expect(requirementFix(check(over), 'demo/1').alternative).toBeUndefined();
		}
	});

	it('re-attaches in place when only the content type missed', () => {
		// Right type, wrong content type: a new version under the same name is
		// enough, so no delete.
		const fix = requirementFix(
			check({
				artifact: 'shot',
				status: 'type_mismatch',
				type: 'file',
				content_type: 'image/',
				current_type: 'file',
				current_version: version
			}),
			'demo/1'
		);
		expect(fix.kind).toBe('attach');
		expect(fix.command).toBe('tines issues artifacts attach demo/1 shot <path>');
	});

	it('deletes first when the slot holds the wrong immutable type', () => {
		const fix = requirementFix(
			check({
				status: 'type_mismatch',
				type: 'text',
				content_type: 'text/markdown',
				current_type: 'link',
				current_version: version
			}),
			'demo/1'
		);
		expect(fix.kind).toBe('delete_and_attach');
		expect(fix.command).toBe(
			'tines issues artifacts delete demo/1 design-doc && tines issues artifacts attach demo/1 design-doc design-doc.md'
		);
	});

	it('treats a folder or link under an untyped requirement as un-re-attachable', () => {
		// An untyped requirement with a content_type is only meaningful over
		// file or text, so any other type in the slot has to go.
		for (const current_type of ['link', 'pr', 'folder'] as const) {
			expect(
				requirementFix(
					check({
						status: 'type_mismatch',
						content_type: 'text/',
						current_type,
						current_version: version
					}),
					'demo/1'
				).kind
			).toBe('delete_and_attach');
		}
		for (const current_type of ['file', 'text'] as const) {
			expect(
				requirementFix(
					check({
						status: 'type_mismatch',
						content_type: 'text/',
						current_type,
						current_version: version
					}),
					'demo/1'
				).kind
			).toBe('attach');
		}
	});

	it('gives a satisfied requirement the command for its next version', () => {
		expect(
			requirementFix(
				check({ status: 'satisfied', type: 'pr', current_type: 'pr', current_version: version }),
				'demo/1'
			)
		).toEqual({
			kind: 'attach',
			command: 'tines issues artifacts attach demo/1 design-doc <owner/repo#N>'
		});
	});

	it('quotes the ref it was given, verbatim', () => {
		expect(requirementFix(check(), 'My Project/241').command).toContain(
			'My Project/241 design-doc'
		);
	});
});
