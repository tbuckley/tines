import type { AllowedTransition, ArtifactRequirementCheck, ArtifactType } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import {
	attachGateHint,
	attachGateWarning,
	effectiveContentType,
	gatesForName
} from './artifact-gates';

const check = (over: Partial<ArtifactRequirementCheck> = {}): ArtifactRequirementCheck => ({
	artifact: 'design-doc',
	status: 'missing',
	current_version: null,
	current_type: null,
	fix: 'tines issues artifacts attach demo/1 design-doc --text <markdown|@file>',
	...over
});

const transition = (name: string, requires: ArtifactRequirementCheck[]): AllowedTransition => ({
	transition_id: `t_${name}`,
	name,
	to_state: { id: 's', name: 'Next', category: 'active', position: 0, inherits_from: null },
	requires
});

const gates = (...ts: AllowedTransition[]) => gatesForName(ts, 'design-doc');

describe('gatesForName', () => {
	it('keeps only this slot, in allowed-transition order', () => {
		const found = gates(
			transition('approve', [check({ artifact: 'impl-pr' }), check({ type: 'text' })]),
			transition('ship', [check({ type: 'file' })])
		);
		expect(found.map((g) => [g.transition, g.check.type])).toEqual([
			['approve', 'text'],
			['ship', 'file']
		]);
	});

	it('is empty for a name nothing gates, and for a transition with no requirements', () => {
		expect(gatesForName([transition('approve', [check()])], 'notes')).toEqual([]);
		expect(
			gatesForName([{ ...transition('approve', []), requires: undefined }], 'design-doc')
		).toEqual([]);
	});
});

describe('attachGateHint', () => {
	it('pre-selects the gate type and the concrete content type', () => {
		const hint = attachGateHint(
			gates(transition('approve', [check({ type: 'text', content_type: 'text/markdown' })]))
		);
		expect(hint).toEqual({
			type: 'text',
			transition: 'approve',
			spec: 'text, text/markdown',
			others: [],
			contentType: 'text/markdown'
		});
	});

	it('takes the first typed gate and lists the rest', () => {
		const hint = attachGateHint(
			gates(
				transition('approve', [check({ type: 'text', content_type: 'text/markdown' })]),
				transition('ship', [check({ type: 'file' })])
			)
		);
		expect(hint?.type).toBe('text');
		expect(hint?.transition).toBe('approve');
		expect(hint?.others).toEqual([{ transition: 'ship', spec: 'file' }]);
	});

	it('declares nothing for a prefix content type — the server sniffs it', () => {
		const hint = attachGateHint(
			gates(transition('ship', [check({ type: 'file', content_type: 'image/' })]))
		);
		expect(hint?.type).toBe('file');
		expect(hint?.spec).toBe('file, image/');
		expect(hint?.contentType).toBeUndefined();
	});

	it('declares nothing when two gates of the same type disagree on the MIME', () => {
		const hint = attachGateHint(
			gates(
				transition('approve', [check({ type: 'text', content_type: 'text/markdown' })]),
				transition('ship', [check({ type: 'text', content_type: 'text/plain' })])
			)
		);
		expect(hint?.contentType).toBeUndefined();
	});

	it('lists a repeated gate once', () => {
		const hint = attachGateHint(
			gates(
				transition('approve', [check({ type: 'text' })]),
				transition('ship', [check({ type: 'file' })]),
				transition('ship', [check({ type: 'file' })])
			)
		);
		expect(hint?.others).toEqual([{ transition: 'ship', spec: 'file' }]);
	});

	it('has no opinion without a declared type', () => {
		expect(attachGateHint(gates(transition('approve', [check()])))).toBeNull();
		expect(attachGateHint([])).toBeNull();
	});
});

describe('attachGateWarning', () => {
	const warn = (type: ArtifactType, contentType: string | undefined, ...ts: AllowedTransition[]) =>
		attachGateWarning(gates(...ts), type, contentType);

	it('warns with the type the gate wants', () => {
		expect(warn('file', undefined, transition('approve', [check({ type: 'text' })]))).toEqual({
			transition: 'approve',
			wants: 'text',
			others: []
		});
	});

	it('warns on a content type the gate rejects, naming the MIME', () => {
		const gate = transition('approve', [check({ type: 'text', content_type: 'text/markdown' })]);
		expect(warn('text', 'text/plain', gate)?.wants).toBe('text/markdown');
		expect(warn('text', 'text/markdown', gate)).toBeNull();
		// An undeclared content type cannot be refused offline — the server decides.
		expect(warn('text', undefined, gate)).toBeNull();
	});

	it('stays quiet when one gate accepts, and lists the others when none does', () => {
		const text = transition('approve', [check({ type: 'text' })]);
		const file = transition('ship', [check({ type: 'file' })]);
		expect(warn('file', undefined, text, file)).toBeNull();
		expect(warn('link', undefined, text, file)).toEqual({
			transition: 'approve',
			wants: 'text',
			others: ['ship']
		});
	});

	it('warns on a file whose own MIME a concrete gate rejects', () => {
		// The panel's derivation chain, end to end: the file branch of the write
		// declares the picked file's type, never the gate's, so the check has to
		// read the file — the stricter gate was the quiet one before (Tines/275
		// review round 1).
		const found = gates(
			transition('archive', [check({ type: 'file', content_type: 'application/pdf' })])
		);
		const ct = (fileType: string | undefined) =>
			effectiveContentType('file', attachGateHint(found)?.contentType, fileType);
		expect(attachGateWarning(found, 'file', ct('image/png'))?.wants).toBe('application/pdf');
		expect(attachGateWarning(found, 'file', ct('application/pdf'))).toBeNull();
		// Nothing picked yet: there is no claim to refuse.
		expect(attachGateWarning(found, 'file', ct(undefined))).toBeNull();
	});

	it('never warns on an ungated slot or an untyped requirement', () => {
		expect(warn('link', undefined)).toBeNull();
		expect(warn('link', undefined, transition('approve', [check()]))).toBeNull();
	});
});

describe('effectiveContentType', () => {
	it('declares the gate MIME for text, and the picked file itself for a file', () => {
		expect(effectiveContentType('text', 'text/plain', undefined)).toBe('text/plain');
		expect(effectiveContentType('text', undefined, undefined)).toBe('text/markdown');
		expect(effectiveContentType('file', undefined, 'image/png')).toBe('image/png');
		// The upload declares the file, so the gate's MIME must not stand in for it.
		expect(effectiveContentType('file', 'application/pdf', 'image/png')).toBe('image/png');
		// No file picked yet, and the types that declare nothing.
		expect(effectiveContentType('file', 'application/pdf', undefined)).toBeUndefined();
		expect(effectiveContentType('folder', 'application/zip', undefined)).toBeUndefined();
		expect(effectiveContentType('pr', undefined, undefined)).toBeUndefined();
	});
});
