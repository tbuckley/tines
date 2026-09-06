import type { ArtifactRequirementCheck, ArtifactType } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import {
	assertOneSource,
	gateLabel,
	planAttach,
	satisfiedBy,
	type AttachFlags,
	type AttachPlan,
	type GateEntry,
	type Probe
} from './attach-source.js';
import { CliError } from './errors.js';

/** A fake filesystem: names listed here exist, a trailing "/" marks a directory. */
const probeOf = (paths: string[]): Probe => {
	const dirs = new Set(paths.filter((p) => p.endsWith('/')).map((p) => p.slice(0, -1)));
	const files = new Set(paths.filter((p) => !p.endsWith('/')));
	return (path) => (dirs.has(path) ? 'dir' : files.has(path) ? 'file' : 'missing');
};

const sniff = (path: string): string => (path.endsWith('.md') ? 'text/markdown' : 'image/png');

const gate = (
	transition: string,
	check: Partial<ArtifactRequirementCheck> & { artifact: string }
): GateEntry => ({
	transition,
	check: {
		status: 'missing',
		current_type: null,
		current_version: null,
		fix: `tines issues artifacts attach Proj/1 ${check.artifact} --text @${check.artifact}.md`,
		...check
	}
});

const textGate = gate('Submit for review', {
	artifact: 'prd',
	type: 'text',
	content_type: 'text/markdown'
});

const plan = (
	opts: {
		positional?: string;
		flags?: AttachFlags;
		gates?: GateEntry[];
		paths?: string[];
		name?: string;
	} = {}
): AttachPlan =>
	planAttach(
		{
			ref: 'Proj/1',
			name: opts.name ?? 'prd',
			positional: opts.positional,
			flags: opts.flags ?? {},
			gates: opts.gates ?? [],
			probe: probeOf(opts.paths ?? [])
		},
		sniff
	);

describe('assertOneSource', () => {
	it('names the positional form when nothing was passed', () => {
		expect(() => assertOneSource({})).toThrow(/positional <source>/);
	});

	it('refuses a positional alongside a flag', () => {
		expect(() => assertOneSource({ text: 'x' }, 'prd.md')).toThrow(
			/pass the source once: got --text and the positional "prd.md"/
		);
	});

	it('refuses two flags', () => {
		expect(() => assertOneSource({ text: 'x', link: 'https://e.com' })).toThrow(
			/pass the source once: got --text and --link/
		);
	});

	it('accepts exactly one', () => {
		expect(() => assertOneSource({ file: 'a.png' })).not.toThrow();
		expect(() => assertOneSource({}, 'a.png')).not.toThrow();
	});
});

describe('planAttach — positional under a gate', () => {
	it('reads a path as the document under a text gate, declaring the gate MIME', () => {
		expect(plan({ positional: 'prd.md', gates: [textGate], paths: ['prd.md'] })).toEqual({
			type: 'text',
			source: { kind: 'text-path', path: 'prd.md' },
			contentType: 'text/markdown'
		});
	});

	it('leaves the filename unset, so it is byte-identical to --text @path', () => {
		expect(plan({ positional: 'prd.md', gates: [textGate], paths: ['prd.md'] }).filename).toBe(
			undefined
		);
	});

	it('sends no content type when the gate declares none', () => {
		const g = gate('Submit', { artifact: 'prd', type: 'text' });
		expect(plan({ positional: 'prd.md', gates: [g], paths: ['prd.md'] }).contentType).toBe(
			undefined
		);
	});

	it('leaves a prefix content type to the server rather than declaring it', () => {
		const g = gate('Submit', { artifact: 'shot', type: 'file', content_type: 'image/' });
		const p = plan({ name: 'shot', positional: 'a.png', gates: [g], paths: ['a.png'] });
		expect(p).toEqual({ type: 'file', source: { kind: 'file-path', path: 'a.png' } });
	});

	it('reads "-" as stdin under a text gate', () => {
		expect(plan({ positional: '-', gates: [textGate] }).source).toEqual({ kind: 'text-stdin' });
	});

	it('reads "-" as stdin bytes under a file gate', () => {
		const g = gate('Submit', { artifact: 'prd', type: 'file' });
		expect(plan({ positional: '-', gates: [g] }).source).toEqual({ kind: 'file-stdin' });
	});

	it('refuses a directory under a text gate', () => {
		expect(() => plan({ positional: 'docs', gates: [textGate], paths: ['docs/'] })).toThrow(
			'"docs" is a directory; "prd" is gated as text'
		);
	});

	it('refuses a missing path under a text gate', () => {
		expect(() => plan({ positional: 'prd.md', gates: [textGate] })).toThrow('cannot read prd.md');
	});

	it.each<[ArtifactType, string, string[], AttachPlan['source']]>([
		['folder', 'notes', ['notes/'], { kind: 'folder', dir: 'notes' }],
		['link', 'https://e.com/x', [], { kind: 'link', url: 'https://e.com/x' }],
		[
			'pr',
			'o/r#7',
			[],
			{ kind: 'pr', pr: { repo_url: 'https://github.com/o/r', number: 7 } }
		]
	])('types a positional under a %s gate', (type, positional, paths, source) => {
		const g = gate('Submit', { artifact: 'prd', type });
		expect(plan({ positional, gates: [g], paths })).toEqual({ type, source });
	});

	it.each([
		['folder', 'notes.md', /is not a directory/],
		['link', 'notes.md', /is not an http\(s\) URL/],
		['pr', 'notes.md', /is not owner\/repo#N/]
	] as [ArtifactType, string, RegExp][])(
		'refuses the wrong shape under a %s gate',
		(type, positional, message) => {
			const g = gate('Submit', { artifact: 'prd', type });
			expect(() => plan({ positional, gates: [g], paths: ['notes.md'] })).toThrow(message);
		}
	);

	it('lets the shape discriminate between gates of different types', () => {
		const gates = [
			gate('Submit', { artifact: 'prd', type: 'text' }),
			gate('Link it', { artifact: 'prd', type: 'pr' })
		];
		expect(plan({ positional: 'o/r#7', gates }).type).toBe('pr');
		expect(plan({ positional: 'prd.md', gates, paths: ['prd.md'] }).type).toBe('text');
	});

	it('refuses when several gates want different types and the shape does not choose', () => {
		const gates = [
			gate('Submit', { artifact: 'prd', type: 'text' }),
			gate('Upload', { artifact: 'prd', type: 'file' })
		];
		expect(() => plan({ positional: 'prd.md', gates, paths: ['prd.md'] })).toThrow(
			'"prd" is gated as text by "Submit" and as file by "Upload"; pass --text/--file to choose'
		);
	});

	it('unescapes a leading @@ and strips a single @', () => {
		expect(plan({ positional: '@prd.md', gates: [textGate], paths: ['prd.md'] }).source).toEqual({
			kind: 'text-path',
			path: 'prd.md'
		});
		expect(
			plan({ positional: '@@prd.md', gates: [textGate], paths: ['@prd.md'] }).source
		).toEqual({ kind: 'text-path', path: '@prd.md' });
	});
});

describe('planAttach — positional with no gate', () => {
	it('types a directory as a folder', () => {
		expect(plan({ positional: 'notes', paths: ['notes/'] })).toEqual({
			type: 'folder',
			source: { kind: 'folder', dir: 'notes' }
		});
	});

	it('types a .md file as a file, never text', () => {
		expect(plan({ positional: 'prd.md', paths: ['prd.md'] })).toEqual({
			type: 'file',
			source: { kind: 'file-path', path: 'prd.md' }
		});
	});

	it('types a GitHub PR URL as a pr and any other URL as a link', () => {
		expect(plan({ positional: 'https://github.com/o/r/pull/7' }).type).toBe('pr');
		expect(plan({ positional: 'https://example.com/doc' }).type).toBe('link');
	});

	it('types owner/repo#N as a pr', () => {
		expect(plan({ positional: 'o/r#7' }).type).toBe('pr');
	});

	it('refuses an unreadable path, pointing at --text for inline prose', () => {
		expect(() => plan({ positional: 'a sentence of prose' })).toThrow(
			/no such file "a sentence of prose".*inline text goes in --text/s
		);
	});

	it('refuses a bare "-" with no gate to type it', () => {
		expect(() => plan({ positional: '-' })).toThrow(/use --text - for a document/);
	});
});

describe('planAttach — flags and refusals', () => {
	it('refuses --file against a text gate, before any request, quoting the gate fix', () => {
		expect(() => plan({ flags: { file: 'prd.md' }, gates: [textGate], paths: ['prd.md'] })).toThrow(
			'"prd" is gated by "Submit for review" as text (text/markdown); --file would create a file artifact that can never satisfy it. Use: tines issues artifacts attach Proj/1 prd --text @prd.md (or --ignore-gates to attach a file anyway)'
		);
	});

	it('names both transitions when two gates reject the type', () => {
		const gates = [textGate, gate('Publish', { artifact: 'prd', type: 'text' })];
		expect(() => plan({ flags: { link: 'https://e.com' }, gates })).toThrow(
			/gated by "Submit for review" and "Publish" as text/
		);
	});

	it('names --content-type when only the content type misses', () => {
		const g = gate('Submit', { artifact: 'shot', type: 'file', content_type: 'image/' });
		expect(() =>
			plan({ name: 'shot', flags: { file: 'a.md' }, gates: [g], paths: ['a.md'] })
		).toThrow(/would attach text\/markdown, which does not satisfy it.*--content-type <mime under image\/>/s);
	});

	it('accepts a flag when at least one gate accepts it', () => {
		const gates = [textGate, gate('Link it', { artifact: 'prd', type: 'link' })];
		expect(plan({ flags: { link: 'https://e.com' }, gates }).type).toBe('link');
	});

	it('refuses a wrong-type existing slot with the delete-and-reattach command', () => {
		const g = gate('Submit for review', {
			artifact: 'prd',
			type: 'text',
			content_type: 'text/markdown',
			status: 'type_mismatch',
			current_type: 'link',
			current_version: { version: 1, created_at: 0 },
			fix: 'tines issues artifacts delete Proj/1 prd && tines issues artifacts attach Proj/1 prd --text @prd.md'
		});
		expect(() => plan({ positional: 'prd.md', gates: [g], paths: ['prd.md'] })).toThrow(
			'"prd" already holds a link artifact and the type is immutable; the positional source would attach text. Use: tines issues artifacts delete Proj/1 prd && tines issues artifacts attach Proj/1 prd --text @prd.md (or --ignore-gates to attach it anyway)'
		);
	});

	it('computes the fix locally when an older server omitted it', () => {
		const g = { ...textGate, check: { ...textGate.check, fix: '' } };
		expect(() => plan({ flags: { file: 'prd.md' }, gates: [g], paths: ['prd.md'] })).toThrow(
			/Use: tines issues artifacts attach Proj\/1 prd --text @prd\.md/
		);
	});

	it('refuses a missing --file path offline', () => {
		expect(() => plan({ flags: { file: 'gone.png' } })).toThrow('cannot read gone.png: no such file');
	});

	it('refuses a --folder that is not a directory', () => {
		expect(() => plan({ flags: { folder: 'prd.md' }, paths: ['prd.md'] })).toThrow(
			'--folder needs a directory, got "prd.md"'
		);
	});

	it('classifies --text inline, @file and - without reading anything', () => {
		expect(plan({ flags: { text: 'hello' } }).source).toEqual({ kind: 'text-inline', value: 'hello' });
		expect(plan({ flags: { text: '@prd.md' } }).source).toEqual({ kind: 'text-path', path: 'prd.md' });
		expect(plan({ flags: { text: '-' } }).source).toEqual({ kind: 'text-stdin' });
		expect(plan({ flags: { text: '@@lit' } }).source).toEqual({ kind: 'text-inline', value: '@lit' });
	});

	it('throws CliError, so the top-level handler prints error: and exits 1', () => {
		expect(() => plan({ flags: { pr: 'nope' } })).toThrow(CliError);
	});
});

describe('planAttach — --ignore-gates', () => {
	it('skips inference, typing a .md positional by shape', () => {
		expect(
			plan({
				positional: 'prd.md',
				flags: { ignoreGates: true },
				gates: [textGate],
				paths: ['prd.md']
			}).type
		).toBe('file');
	});

	it('skips the acceptance and existing-slot checks', () => {
		const g = gate('Submit for review', {
			artifact: 'prd',
			type: 'text',
			current_type: 'link',
			status: 'type_mismatch',
			current_version: { version: 1, created_at: 0 }
		});
		expect(
			plan({ flags: { file: 'prd.md', ignoreGates: true }, gates: [g], paths: ['prd.md'] }).type
		).toBe('file');
	});
});

const artifact = (type: ArtifactType, contentType: string | null) => ({
	name: 'prd',
	artifact_type: type,
	current_version: { content_type: contentType } as never
});

describe('satisfiedBy / gateLabel', () => {
	it('reports the transitions a fresh artifact satisfies', () => {
		const gates = [textGate, gate('Publish', { artifact: 'prd', type: 'text' })];
		expect(satisfiedBy(artifact('text', 'text/markdown'), gates)).toEqual({
			satisfies: ['Submit for review', 'Publish'],
			rejects: []
		});
	});

	it('reports what a rejecting gate wanted instead', () => {
		expect(satisfiedBy(artifact('link', null), [textGate]).rejects).toEqual([
			{ transition: 'Submit for review', wants: 'wants text' }
		]);
	});

	it('rejects on the content type when the type is right', () => {
		expect(satisfiedBy(artifact('text', 'text/plain'), [textGate]).rejects).toEqual([
			{ transition: 'Submit for review', wants: 'wants text/markdown' }
		]);
	});

	it('ignores gates on other slots', () => {
		const other = gate('Other', { artifact: 'design-doc', type: 'folder' });
		expect(satisfiedBy(artifact('text', 'text/markdown'), [other])).toEqual({
			satisfies: [],
			rejects: []
		});
	});

	it('an untyped gate accepts anything', () => {
		const g = gate('Any', { artifact: 'prd' });
		expect(satisfiedBy(artifact('link', null), [g]).satisfies).toEqual(['Any']);
	});

	it('gateLabel is empty when nothing rejects, and dedupes otherwise', () => {
		expect(gateLabel(artifact('text', 'text/markdown'), [textGate])).toBe('');
		expect(
			gateLabel(artifact('link', null), [textGate, gate('Publish', { artifact: 'prd', type: 'text' })])
		).toBe('wants text');
	});
});
