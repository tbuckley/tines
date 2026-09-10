import { describe, expect, it } from 'vitest';
import {
	canonicalizeLibraryValue,
	inputToken,
	LibraryValidationError,
	libraryDocumentDigest,
	parseLibraryV3Document,
	renderDeclaredToken,
	withLibraryDocumentDigest,
	type WorkflowPackageDocument
} from './index.js';

function candidate(): WorkflowPackageDocument {
	return {
		format: 'tines.library',
		version: 3,
		profile: 'workflow',
		exported_at: 1,
		digest: '',
		main_workflow_id: 'workflow:1',
		workflows: [
			{
				id: 'workflow:1',
				name: 'QA',
				description: 'portable',
				initial_state_id: 'state:1',
				states: [{ id: 'state:1', name: 'Ready', category: 'active', inherits_from: null }],
				transitions: []
			}
		],
		context: [],
		inputs: [],
		text_uses: [],
		schedules: [],
		routing: []
	};
}

describe('workflow package canonical contract', () => {
	it('uses sorted RFC 8785 object keys and preserves array order', () => {
		expect(canonicalizeLibraryValue({ z: [3, 2, 1], a: 'x' })).toBe('{"a":"x","z":[3,2,1]}');
	});

	it('adds and verifies a digest independent of JSON whitespace and key order', async () => {
		const document = await withLibraryDocumentDigest(candidate());
		const source = JSON.stringify(document, null, 2);
		expect((await parseLibraryV3Document(source)).digest).toBe(document.digest);
		expect(document.digest).toBe(await libraryDocumentDigest({ ...document, digest: 'ignored' }));
	});

	it('rejects duplicate keys after JSON escape decoding', async () => {
		const source = '{"format":"tines.library","\\u0066ormat":"again"}';
		await expect(parseLibraryV3Document(source)).rejects.toMatchObject({
			diagnostics: [{ code: 'duplicate_key', path: '/format' }]
		});
	});

	it('rejects malformed UTF-8 before parsing', async () => {
		await expect(parseLibraryV3Document(new Uint8Array([0xc3, 0x28]))).rejects.toMatchObject({
			diagnostics: [{ code: 'invalid_utf8' }]
		});
	});

	it('reports document-local identity collisions', async () => {
		const document = candidate();
		document.context.push({
			id: 'state:1',
			state_id: 'state:1',
			kind: 'prompt',
			name: 'instructions',
			description: '',
			body: 'x'
		});
		await expect(libraryDocumentDigest(document)).rejects.toBeInstanceOf(LibraryValidationError);
		delete (document as Partial<WorkflowPackageDocument>).digest;
		await expect(
			parseLibraryV3Document(JSON.stringify(document), { allowMissingDigest: true })
		).rejects.toBeInstanceOf(LibraryValidationError);
	});
});

describe('declared input rendering', () => {
	it('escapes defaults and substitutes only declared unescaped occurrences once', () => {
		const token = inputToken('destination', 'a:b}c\\d');
		expect(token).toBe('{{destination:a\\:b\\}c\\\\d}}');
		const rendered = renderDeclaredToken(
			`Use ${token}; literal \\${token}`,
			token,
			'{{not_recursive:}}'
		);
		expect(rendered).toEqual({
			value: 'Use {{not_recursive:}}; literal {{destination:a\\:b\\}c\\\\d}}',
			count: 1
		});
	});

	it('leaves unrelated runtime placeholders untouched', () => {
		expect(renderDeclaredToken('Run {{date}} at {{time}}', '{{name:}}', 'x')).toEqual({
			value: 'Run {{date}} at {{time}}',
			count: 0
		});
	});
});
