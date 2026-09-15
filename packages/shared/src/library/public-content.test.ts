import { describe, expect, it } from 'vitest';
import { inheritedPackage } from './fixtures.js';
import { validatePublicWorkflowDocument } from './public-content.js';
import { withLibraryDocumentDigest } from './canonical.js';
import { parsePublicWorkflowDocument } from './public-content.js';

describe('public workflow content policy', () => {
	it('accepts text packages and preserves exact canonical bytes', async () => {
		const document = await withLibraryDocumentDigest(inheritedPackage());
		const result = await parsePublicWorkflowDocument(JSON.stringify(document, null, 2));
		expect(result.diagnostics).toEqual([]);
		expect(result.byte_length).toBe(new TextEncoder().encode(result.canonical_json).byteLength);
		expect(result.bytes_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it('rejects Markdown images but permits image syntax in code', () => {
		const document = inheritedPackage();
		const prompt = document.context.find((item) => item.kind === 'prompt');
		if (!prompt || prompt.kind !== 'prompt') throw new Error('fixture prompt missing');
		prompt.body =
			'![tracking](https://publisher.example/pixel)\n\n`![literal](x)`\n\n```md\n![also literal](x)\n```';
		expect(validatePublicWorkflowDocument(document)).toMatchObject([
			{ path: '/context/0/body', code: 'markdown_image', record_id: 'context:1' }
		]);
	});

	it('rejects image references, controls, unsafe file types, shebangs and case collisions', () => {
		const document = inheritedPackage();
		const skill = document.context.find((item) => item.kind === 'skill');
		if (!skill || skill.kind !== 'skill') throw new Error('fixture skill missing');
		skill.files = [
			{
				id: 'file:1',
				path: 'guide.MD',
				content: '![track][x]\n\n[x]: https://publisher.example/pixel'
			},
			{ id: 'file:2', path: 'GUIDE.md', content: 'bad\u0000text' },
			{ id: 'file:3', path: 'run.sh', content: '#!/bin/sh\necho no' }
		];
		const codes = validatePublicWorkflowDocument(document).map(({ code }) => code);
		expect(codes).toContain('markdown_image');
		expect(codes).toContain('path_case_collision');
		expect(codes).toContain('forbidden_control');
		expect(codes).toContain('forbidden_file_type');
		expect(codes).toContain('executable_or_binary');
	});

	it('does not treat raw HTML as active content', () => {
		const document = inheritedPackage();
		const prompt = document.context.find((item) => item.kind === 'prompt');
		if (!prompt || prompt.kind !== 'prompt') throw new Error('fixture prompt missing');
		prompt.body = '<img src="https://publisher.example/pixel"><script>alert(1)</script>';
		expect(validatePublicWorkflowDocument(document)).toEqual([]);
	});
});
