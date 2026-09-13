import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { inheritedPackage, automatedPackage, duplicateLibrary } from './fixtures.js';
import {
	canonicalizeLibraryValue,
	libraryDocumentDigest,
	parseLibraryV3Document,
	renderDeclaredTokens,
	withLibraryDocumentDigest
} from './index.js';

const parseDraft = (value: unknown) => {
	const object = value as Record<string, unknown>;
	return parseLibraryV3Document(JSON.stringify({ ...object, digest: undefined }), {
		allowMissingDigest: true
	});
};
// Deliberately unknown inputs exercise the runtime boundary, not TypeScript's interface.
function changed(path: string, value: unknown, source: unknown = automatedPackage()): unknown {
	const document = structuredClone(source) as Record<string, unknown>;
	const keys = path.split('/').slice(1);
	let target: Record<string, unknown> = document;
	for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
	target[keys.at(-1)!] = value;
	return document;
}

describe('strict portable document boundary', () => {
	it.each(['\u00a0', '\u000b', '\ufeff'])('rejects non-JSON whitespace %j', async (space) => {
		await expect(parseLibraryV3Document(space + '{}')).rejects.toMatchObject({
			diagnostics: [{ code: 'invalid_json' }]
		});
	});
	it('rejects a UTF-8 BOM consistently with string input', async () => {
		await expect(
			parseLibraryV3Document(new TextEncoder().encode('\ufeff{}'))
		).rejects.toMatchObject({ diagnostics: [{ code: 'invalid_json' }] });
	});
	it.each(['"\\ud800"', '"\\ud800x"', '"\\udc00"', JSON.stringify('\ud800'), '"' + '\ud800' + '"'])(
		'rejects lone surrogates %j',
		async (source) => {
			await expect(parseLibraryV3Document(source)).rejects.toMatchObject({
				diagnostics: [{ code: 'invalid_unicode' }]
			});
		}
	);
	it('does not lose prototype keys before schema validation', async () => {
		const source = JSON.stringify(inheritedPackage()).replace(
			'"description":"Shared review instructions"',
			'"description":"Shared review instructions","__proto__":{"polluted":true}'
		);
		await expect(
			parseLibraryV3Document(source, { allowMissingDigest: true })
		).rejects.toMatchObject({ diagnostics: [{ path: '/digest', code: 'invalid_digest' }] });
		const draft = source.replace('"digest":"",', '');
		await expect(parseLibraryV3Document(draft, { allowMissingDigest: true })).rejects.toMatchObject(
			{ diagnostics: [{ path: '/workflows/1/__proto__', code: 'unknown_field' }] }
		);
		expect(Object.prototype).not.toHaveProperty('polluted');
	});
	it.each([
		['/workflows', null],
		['/workflows/0/states', {}],
		['/workflows/0/states/0', null],
		['/workflows/0/states/0/name', 1],
		['/workflows/0/transitions/0/requires', false],
		['/context/1/files/0/content', []],
		['/inputs/0/default', {}],
		['/text_uses/0/target', null],
		['/routing/0/scope', 'x'],
		['/schedules/0/require_all_closed', 'false']
	])('rejects wrong nested type at %s before reference traversal', async (path, value) => {
		await expect(parseDraft(changed(path as string, value))).rejects.toMatchObject({
			diagnostics: [{ path, code: 'invalid_type' }]
		});
	});
	it.each([
		['/workflows/0/unrecognized', 1],
		['/workflows/0/states/0/prompt', 'inline'],
		['/workflows/0/transitions/0/requires/0/extra', 1],
		['/context/0/journal', false],
		['/context/1/files/0/extra', true],
		['/inputs/0/extra', true],
		['/text_uses/0/target/extra', true],
		['/schedules/0/recurrence/preset/cron', '0 * * * *'],
		['/routing/0/runner_id', 'source-runner']
	])('rejects unknown nested member %s', async (path, value) => {
		await expect(parseDraft(changed(path as string, value))).rejects.toMatchObject({
			diagnostics: [{ path, code: 'unknown_field' }]
		});
	});
	it.each([
		['/workflows/0/states/0/inherits_from', { kind: 'public_snapshot', host: 'example.org' }],
		['/schedules/0/workflow', { kind: 'input_workflow', input_id: 'input:1' }],
		['/schedules/0/recurrence', { kind: 'unknown' }]
	])('rejects unsupported references/variants at %s', async (path, value) => {
		await expect(parseDraft(changed(path as string, value))).rejects.toMatchObject({
			diagnostics: [expect.objectContaining({ code: expect.stringMatching(/invalid_|unknown_/) })]
		});
	});
	it('rejects unsafe integers and excessive raw bytes/depth', async () => {
		await expect(parseDraft(changed('/exported_at', 2 ** 53))).rejects.toMatchObject({
			diagnostics: [{ code: 'invalid_integer' }]
		});
		await expect(parseLibraryV3Document(' '.repeat(5 * 1024 * 1024 + 1))).rejects.toMatchObject({
			diagnostics: [{ code: 'package_too_large' }]
		});
		await expect(
			parseLibraryV3Document('['.repeat(65) + '0' + ']'.repeat(65))
		).rejects.toMatchObject({ diagnostics: [{ code: 'maximum_depth' }] });
	});
	it('applies the same Unicode and schema boundary to in-memory digest authors', async () => {
		await expect(
			libraryDocumentDigest(changed('/workflows/0/description', '\ud800') as never)
		).rejects.toMatchObject({ diagnostics: [{ code: 'invalid_unicode' }] });
		await expect(
			withLibraryDocumentDigest(changed('/context/0/unrecognized', true) as never)
		).rejects.toMatchObject({ diagnostics: [{ code: 'unknown_field' }] });
		expect(() => canonicalizeLibraryValue({ '\udc00': 'x' })).toThrow();
		expect(() => canonicalizeLibraryValue({ date: new Date() })).toThrow();
	});
});

describe('complete typed identity and domain checks', () => {
	it.each([
		['/main_workflow_id', 'state:1', 'invalid_reference'],
		['/workflows/0/initial_state_id', 'state:3', 'invalid_reference'],
		['/workflows/0/initial_state_id', 'state:2', 'invalid_initial_state'],
		['/workflows/0/transitions/0/to_state_id', 'state:3', 'invalid_reference'],
		['/workflows/0/transitions/0/to_state_id', 'state:1', 'self_transition'],
		['/workflows/0/states/0/inherits_from/state_id', 'missing', 'invalid_reference'],
		['/context/0/state_id', 'workflow:1', 'invalid_reference'],
		['/context/1/files/0/id', 'state:1', 'duplicate_local_id'],
		['/text_uses/0/input_id', 'context:1', 'invalid_reference'],
		['/text_uses/0/target/field', 'name', 'invalid_value'],
		['/text_uses/0/target/field', 'body', 'invalid_reference'],
		['/text_uses/0/token', '{{filing_label:other}}', 'invalid_token'],
		['/schedules/0/workflow/workflow_id', 'input:1', 'invalid_reference'],
		['/schedules/0/project/input_id', 'input:1', 'invalid_reference'],
		[
			'/schedules/0/start_state',
			{ kind: 'bundled_state', state_id: 'state:3' },
			'invalid_reference'
		],
		['/routing/0/scope/state_id', 'workflow:1', 'invalid_reference'],
		['/routing/0/scope/project/input_id', 'input:1', 'invalid_reference'],
		['/workflows/0/name', 'x'.repeat(201), 'invalid_field'],
		['/context/0/body', '😀'.repeat(8193), 'package_too_large'],
		['/context/1/files/0/path', '../secret', 'invalid_path'],
		['/context/2/repo_url', 'https://user:password@github.com/owner/repo', 'invalid_repo_url'],
		['/context/2/repo_url', 'https://github.com/owner/repo?key=value', 'invalid_repo_url'],
		['/context/2/repo_url', 'https://github.com/owner/repo#branch', 'invalid_repo_url'],
		['/context/2/repo_url', 'git@github.com:owner/repo', 'invalid_repo_url'],
		['/schedules/0/recurrence/preset/weekday', 7, 'invalid_recurrence'],
		['/schedules/0/recurrence', { kind: 'cron', cron: '* * * * *' }, 'invalid_recurrence'],
		['/schedules/0/timezone', 'Not/AZone', 'invalid_timezone'],
		['/inputs/0/required_states', ['Review'], 'invalid_field'],
		['/inputs/0/default', 'x'.repeat(10001), 'invalid_field']
	])('refuses %s (%s)', async (path, value, code) => {
		await expect(parseDraft(changed(path as string, value))).rejects.toMatchObject({
			diagnostics: [expect.objectContaining({ code })]
		});
	});
	it('validates reachability, cycles and the three-state chain limit independently', async () => {
		const disconnected = inheritedPackage();
		disconnected.workflows[0].states[0].inherits_from = null;
		await expect(parseDraft(disconnected)).rejects.toMatchObject({
			diagnostics: [{ code: 'disconnected_workflow' }]
		});
		const cycle = inheritedPackage();
		cycle.workflows[1].states[0].inherits_from = { kind: 'bundled_state', state_id: 'state:1' };
		await expect(parseDraft(cycle)).rejects.toMatchObject({
			diagnostics: [{ code: 'inheritance_cycle' }]
		});
		const chain = inheritedPackage();
		chain.workflows[1].states[0].inherits_from = { kind: 'bundled_state', state_id: 'state:2' };
		await expect(parseDraft(chain)).resolves.toBeDefined();
		chain.workflows[0].states.push({
			id: 'state:4',
			name: 'Extra',
			category: 'active',
			inherits_from: null
		});
		chain.workflows[0].states[1].inherits_from = { kind: 'bundled_state', state_id: 'state:4' };
		await expect(parseDraft(chain)).rejects.toMatchObject({
			diagnostics: [{ code: 'inheritance_depth' }]
		});
	});
	it('allows workflow-level dependency cycles when state inheritance stays acyclic', async () => {
		const d = inheritedPackage();
		d.workflows[1].states[0].inherits_from = { kind: 'bundled_state', state_id: 'state:2' };
		await expect(parseDraft(d)).resolves.toBeDefined();
	});
	it('rejects duplicate input keys and repeated/missing token uses', async () => {
		const d = inheritedPackage();
		d.inputs.push({ ...d.inputs[0], id: 'input:2' });
		await expect(parseDraft(d)).rejects.toMatchObject({
			diagnostics: [{ code: 'duplicate_input_key' }]
		});
		d.inputs.pop();
		d.text_uses.push({ ...d.text_uses[0], id: 'use:3' });
		await expect(parseDraft(d)).rejects.toMatchObject({
			diagnostics: [{ code: 'duplicate_text_use' }]
		});
		d.text_uses.pop();
		d.workflows[0].description = 'No matching text';
		await expect(parseDraft(d)).rejects.toMatchObject({
			diagnostics: [{ code: 'unused_text_use' }]
		});
	});
	it('counts records across all arrays, not just one array', async () => {
		const d = inheritedPackage();
		d.inputs = Array.from({ length: 1000 }, (_, i) => ({
			...d.inputs[0],
			id: `input:${i}`,
			key: `key_${i}`
		}));
		await expect(parseDraft(d)).rejects.toMatchObject({
			diagnostics: [{ code: 'package_too_large' }]
		});
	});
	it('checks skill count, total bytes and duplicate paths', async () => {
		const d = inheritedPackage();
		const skill = d.context[1];
		if (skill.kind !== 'skill') throw Error('fixture');
		skill.files.push({ ...skill.files[0], id: 'file:2' });
		await expect(parseDraft(d)).rejects.toMatchObject({
			diagnostics: [{ code: 'duplicate_path' }]
		});
		skill.files = [{ id: 'file:1', path: 'SKILL.md', content: '😀'.repeat(25600) }];
		await expect(parseDraft(d)).rejects.toMatchObject({
			diagnostics: [{ code: 'package_too_large' }]
		});
		skill.files = Array.from({ length: 21 }, (_, i) => ({
			id: `file:${i}`,
			path: `${i}.md`,
			content: ''
		}));
		await expect(parseDraft(d)).rejects.toMatchObject({
			diagnostics: [{ code: 'package_too_large' }]
		});
	});
});

describe('library profile retains scope and identity without package authority', () => {
	it('preserves same-named workflow prompts, global/project/label/system scopes and journals', async () => {
		const d = duplicateLibrary();
		const sealed = await parseDraft(d);
		expect(sealed).toEqual({ ...d, digest: expect.stringMatching(/^sha256:/) });
	});
	it.each([
		['/projects/0/default_workflow', { kind: 'input_workflow', input_id: 'x' }],
		['/context/0/scope/state', { kind: 'input_state', input_id: 'x' }],
		['/context/0/state_id', 'state:1'],
		['/inputs', []]
	])('rejects package-only data at %s', async (path, value) => {
		await expect(parseDraft(changed(path as string, value, duplicateLibrary()))).rejects.toThrow();
	});
	it.each([
		['/context/0/scope/project_id', 'missing'],
		['/context/0/scope/label_id', 'state:1'],
		['/context/0/scope/state/state_id', 'missing'],
		['/projects/0/default_workflow/workflow_id', 'state:1'],
		['/context/2/scope/state/state_name', 'Invented']
	])('checks typed library edge %s', async (path, value) => {
		await expect(
			parseDraft(changed(path as string, value, duplicateLibrary()))
		).rejects.toMatchObject({ diagnostics: [{ code: 'invalid_reference' }] });
	});
	it('permits exact Standard inheritance only in library profile', async () => {
		const d = duplicateLibrary();
		d.workflows[0].states[0].inherits_from = {
			kind: 'system_state',
			workflow: 'Standard',
			state_name: 'Open'
		};
		await expect(parseDraft(d)).resolves.toBeDefined();
		await expect(
			parseDraft(
				changed('/workflows/0/states/0/inherits_from', d.workflows[0].states[0].inherits_from)
			)
		).rejects.toThrow();
	});
});

describe('original-text multi-input rendering and canonical identity', () => {
	it('does not expand an inserted value that looks like another declared token', () => {
		expect(
			renderDeclaredTokens('A={{a:}}; B={{b:}}; literal=\\{{a:}}; runtime={{date}}', [
				{ token: '{{a:}}', value: '{{b:}}' },
				{ token: '{{b:}}', value: '$\\value' }
			])
		).toEqual({ value: 'A={{b:}}; B=$\\value; literal={{a:}}; runtime={{date}}', counts: [1, 1] });
	});
	it('rejects overlaps rather than letting declaration order choose the result', () => {
		expect(() =>
			renderDeclaredTokens('abcd', [
				{ token: 'abc', value: 'x' },
				{ token: 'bcd', value: 'y' }
			])
		).toThrow('overlap');
	});
	it('preserves literal backslashes except the single explicit token escape', () => {
		expect(renderDeclaredTokens('\\\\{{a:}} \\other', [{ token: '{{a:}}', value: 'x' }])).toEqual({
			value: '\\{{a:}} \\other',
			counts: [0]
		});
	});
	it('uses ECMAScript number serialization and UTF-16 key sorting (RFC 8785)', () => {
		expect(
			canonicalizeLibraryValue({ numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27, -0] })
		).toBe('{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27,0]}');
		expect(canonicalizeLibraryValue({ '\u20ac': 1, '\r': 2, '😀': 3, '\ufb33': 4, '1': 5 })).toBe(
			'{"\\r":2,"1":5,"€":1,"😀":3,"דּ":4}'
		);
	});
	it.each([inheritedPackage, automatedPackage, duplicateLibrary])(
		'round-trips complete authoring example %s',
		async (fixture) => {
			const sealed = await withLibraryDocumentDigest(fixture());
			expect(await parseLibraryV3Document(JSON.stringify(sealed, null, 2))).toEqual(sealed);
			const reordered = Object.fromEntries(Object.entries(sealed).reverse());
			expect((await parseLibraryV3Document(JSON.stringify(reordered))).digest).toBe(sealed.digest);
		}
	);
	it('binds text, metadata and ordering while preserving Unicode and line endings', async () => {
		const d = inheritedPackage();
		const original = await libraryDocumentDigest(d);
		d.exported_at++;
		expect(await libraryDocumentDigest(d)).not.toBe(original);
		d.exported_at--;
		d.context.reverse();
		expect(await libraryDocumentDigest(d)).not.toBe(original);
		d.context.reverse();
		d.workflows[1].description = 'é\r\n';
		const composed = await libraryDocumentDigest(d);
		d.workflows[1].description = 'e\u0301\n';
		expect(await libraryDocumentDigest(d)).not.toBe(composed);
	});
});

it.each([
	[
		'inherited-workflow',
		inheritedPackage,
		'sha256:188befe188e05dbdb6ac2e11de0541d2336abaca95f7a9b3f4a77ef027bf386a'
	],
	[
		'project-automation',
		automatedPackage,
		'sha256:758f33fd2a2936ac9a7ef72b8c9c9aa7f7cde88d098dd12006dc9f193c878e74'
	],
	[
		'duplicate-library',
		duplicateLibrary,
		'sha256:f09845183e1f44cbc2ea2b104c42de3dac01633f1666f1a0605a94d3c5abe18d'
	]
] as const)('pins published example %s to its golden digest', async (name, fixture, digest) => {
	const file = readFileSync(
		new URL(`../../../../specs/library/examples/${name}.json`, import.meta.url),
		'utf8'
	);
	const document = await parseLibraryV3Document(file);
	expect(document).toEqual({ ...fixture(), digest });
	expect(await libraryDocumentDigest(fixture())).toBe(digest);
});

describe('rendered field review', () => {
	it('provides original/rendered text and exact locations/counts without mutating signed bytes', async () => {
		const { renderPackageFields } = await import('./render.js');
		const d = inheritedPackage();
		const before = structuredClone(d);
		expect(renderPackageFields(d, { 'input:1': 'destination' })).toEqual([
			{
				record_id: 'workflow:1',
				field: 'description',
				original: 'Review {{filing_label:qa}} work',
				rendered: 'Review destination work',
				uses: [{ id: 'use:1', input_id: 'input:1', count: 1 }]
			},
			{
				record_id: 'context:1',
				field: 'body',
				original: 'File work with label {{filing_label:qa}}. Preserve {{date}}.',
				rendered: 'File work with label destination. Preserve {{date}}.',
				uses: [{ id: 'use:2', input_id: 'input:1', count: 1 }]
			}
		]);
		expect(d).toEqual(before);
	});
	it('checks combined field lengths after substitution and missing values', async () => {
		const { renderPackageFields } = await import('./render.js');
		const d = inheritedPackage();
		expect(() => renderPackageFields(d, { 'input:1': 'x'.repeat(10000) })).toThrow('at most 10000');
		expect(() => renderPackageFields(d, {})).toThrow('requires a resolved value');
		expect(() => renderPackageFields(d, { 'input:1': 'x', unexpected: 'x' })).toThrow(
			'Unknown input'
		);
	});
	it.each([1, 2, 4])('keeps version %i outside the strict v3 adapter', async (version) => {
		await expect(parseDraft({ ...inheritedPackage(), version })).rejects.toMatchObject({
			diagnostics: [{ code: 'unsupported_version', path: '/version' }]
		});
	});
});

it('rejects sparse in-memory arrays through both canonical and document APIs', async () => {
	expect(() => canonicalizeLibraryValue(Array(2))).toThrow('Sparse arrays');
	const document = inheritedPackage();
	document.workflows = Array(1);
	await expect(libraryDocumentDigest(document)).rejects.toMatchObject({
		diagnostics: [{ path: '/workflows/0', code: 'invalid_type' }]
	});
});
