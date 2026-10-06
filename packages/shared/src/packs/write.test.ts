import { describe, expect, it } from 'vitest';
import { readPackArchive, writePackArchive } from './archive.js';
import { engineeringPack } from './engineering-fixture.js';
import { parsePack } from './parse.js';
import type { PackModel } from './types.js';
import { packFilesFromRecord, writePackFiles } from './write.js';

async function fixtureModel(): Promise<PackModel> {
	const r = await parsePack(packFilesFromRecord(engineeringPack()));
	expect(r.errors).toEqual([]);
	return r.model!;
}

const text = (files: { path: string; bytes: Uint8Array }[], path: string) =>
	new TextDecoder().decode(files.find((f) => f.path === path)!.bytes);

describe('writePackFiles', () => {
	it('round-trips the spec example: parse(write(m)) equals m', async () => {
		const m = await fixtureModel();
		const files = writePackFiles(m);
		const r = await parsePack(files);
		expect(r.errors).toEqual([]);
		expect(r.warnings).toEqual([]);
		expect(r.model).toEqual(m);
		// And writing is a fixed point.
		expect(writePackFiles(r.model!)).toEqual(files);
	});

	it('round-trips through the archive', async () => {
		const m = await fixtureModel();
		const read = readPackArchive(writePackArchive(writePackFiles(m), 'engineering'));
		expect(read.errors).toEqual([]);
		expect((await parsePack(read.files)).model).toEqual(m);
	});

	it('writes the spec layout', async () => {
		const files = writePackFiles(await fixtureModel());
		expect(files.map((f) => f.path)).toEqual([
			'CHANGELOG.md',
			'README.md',
			'migrations.yaml',
			'pack.yaml',
			'project/conventions.md',
			'project/skills/escalation/SKILL.md',
			'schedules/nightly.yaml',
			'schedules/weekly-triage.yaml',
			'shared/env.yaml',
			'shared/house-style.md',
			'shared/repos.yaml',
			'shared/skills/pr-hygiene/SKILL.md',
			'shared/skills/pr-hygiene/scripts/check.sh',
			'workflows/engineering/overview.md',
			'workflows/engineering/states/implement/instructions.md',
			'workflows/engineering/states/implement/skills/tdd/SKILL.md',
			'workflows/engineering/states/review/instructions.md',
			'workflows/engineering/workflow.yaml',
			'workflows/qa/states/test/instructions.md',
			'workflows/qa/workflow.yaml'
		]);
		expect(text(files, 'pack.yaml')).toMatch(
			/^format: 1\nid: tbuckley\/engineering\nname: Engineering\nversion: 4\ndescription: .*\nderived_from: \{ id: acme\/engineering, version: 2 \}\ninputs:\n  staging_url:\n    type: text\n/
		);
		expect(text(files, 'workflows/engineering/workflow.yaml')).toContain(
			'  implement:\n    name: Implement\n    category: active\n    transitions:\n      Ready for review: { to: review, requires: [ pull-request ] }\n      Blocked: triage\n'
		);
		expect(text(files, 'workflows/qa/workflow.yaml')).toContain('    run_scope: organization\n');
		expect(text(files, 'shared/repos.yaml')).toBe(
			'app: { input: app_repo, dir: app }\ndocs: { url: https://github.com/acme/docs, branch: main, dir: docs }\n'
		);
		expect(text(files, 'schedules/weekly-triage.yaml')).toContain(
			'recurrence: { every: weekly, on: mon, at: "09:00" }\n'
		);
		// Frontmatter only when needed.
		expect(text(files, 'shared/house-style.md')).toBe(
			'Write plainly. Reviewer: {{inputs.reviewer}}.\n'
		);
		expect(text(files, 'project/conventions.md')).toMatch(
			/^---\norder: 10\ndescription: How we write commit messages\n---\nWrite/
		);
	});

	it('round-trips awkward values', async () => {
		const m = await fixtureModel();
		m.manifest.version = null;
		m.manifest.derived_from = { id: 'acme/x', version: null };
		m.manifest.description = 'Line one\nline two: with "quotes" and # hash\n';
		m.readme = null;
		m.changelog = '';
		m.migrations = {};
		m.prompts[1] = {
			...m.prompts[1],
			body: '---\nnot frontmatter\n---\nstill body',
			order: 100,
			description: ''
		};
		m.prompts[2] = { ...m.prompts[2], order: -2.5, description: 'yes' };
		m.env[2] = { ...m.env[2], value: { template: '0123' } };
		m.workflows[0].states[1].transitions[1].name = '42';
		m.schedules[1] = { ...m.schedules[1], recurrence: { every: '2h', at: '15' }, start: null };
		const r = await parsePack(writePackFiles(m));
		expect(r.errors).toEqual([]);
		expect(r.model).toEqual(m);
	});
});
