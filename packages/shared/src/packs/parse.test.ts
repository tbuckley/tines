import { describe, expect, it } from 'vitest';
import { engineeringPack } from './engineering-fixture.js';
import { parsePack } from './parse.js';
import { PACK_TEXT_FILE_MAX_BYTES, type PackFile } from './types.js';
import { packFilesFromRecord } from './write.js';

/** Parses the fixture with some files replaced (string) or removed (null). */
async function parseWith(changes: Record<string, string | null> = {}, extra: PackFile[] = []) {
	const record = engineeringPack();
	for (const [path, text] of Object.entries(changes)) {
		if (text === null) delete record[path];
		else record[path] = text;
	}
	return parsePack([...packFilesFromRecord(record), ...extra]);
}

/** Replaces `from` with `to` in one fixture file. */
function edit(path: string, from: string, to: string): Record<string, string> {
	const text = engineeringPack()[path];
	if (!text.includes(from)) throw new Error(`fixture ${path} has no ${JSON.stringify(from)}`);
	return { [path]: text.replace(from, to) };
}

async function errorCodes(changes: Record<string, string | null>, extra: PackFile[] = []) {
	const r = await parseWith(changes, extra);
	expect(r.model).toBeNull();
	return r.errors.map((e) => e.code);
}

describe('parsePack: the spec example', () => {
	it('parses without errors or warnings', async () => {
		const r = await parseWith();
		expect(r.errors).toEqual([]);
		expect(r.warnings).toEqual([]);
		expect(r.digest).toMatch(/^[0-9a-f]{64}$/);
		const m = r.model!;
		expect(m.manifest).toMatchObject({
			format: 1,
			id: 'tbuckley/engineering',
			version: 4,
			derived_from: { id: 'acme/engineering', version: 2 }
		});
		expect(Object.keys(m.manifest.inputs)).toEqual([
			'staging_url',
			'reviewer',
			'github_token',
			'app_repo',
			'bugs',
			'escalation'
		]);
		expect(m.workflows.map((w) => w.key)).toEqual(['engineering', 'qa']);
		const eng = m.workflows[0];
		expect(eng.states.map((s) => s.key)).toEqual(['triage', 'implement', 'review', 'done']);
		expect(eng.states[1].transitions).toEqual([
			{ name: 'Ready for review', to: 'review', requires: [{ artifact: 'pull-request' }] },
			{ name: 'Blocked', to: 'triage' }
		]);
		expect(m.workflows[1].states[0].run_scope).toBe('organization');
		expect(m.workflows[1].states[0].transitions[1].requires).toEqual([
			{ artifact: 'test-report' },
			{
				artifact: 'screenshots',
				type: 'file',
				content_type: 'image/',
				description: 'What it looked like'
			}
		]);
		expect(m.prompts.map((p) => [p.reach, p.workflow, p.state, p.name])).toEqual([
			['project', null, null, 'conventions'],
			['pack', null, null, 'house-style'],
			['workflow', 'engineering', null, 'overview'],
			['state', 'engineering', 'implement', 'instructions'],
			['state', 'engineering', 'review', 'instructions'],
			['state', 'qa', 'test', 'instructions']
		]);
		expect(m.prompts[0]).toMatchObject({
			order: 10,
			description: 'How we write commit messages',
			body: 'Write commit subjects in the imperative mood. Test against\n{{ inputs.staging_url }} before handing off.\n'
		});
		expect(m.prompts[1].order).toBe(100);
		expect(m.skills.map((s) => [s.reach, s.name, s.files.map((f) => f.path)])).toEqual([
			['project', 'escalation', ['SKILL.md']],
			['pack', 'pr-hygiene', ['SKILL.md', 'scripts/check.sh']],
			['state', 'tdd', ['SKILL.md']]
		]);
		expect(m.skills[1].description).toBe('Keep pull requests tidy');
		expect(m.env.map((e) => [e.name, e.value])).toEqual([
			['API_BASE', { template: '{{ inputs.staging_url }}/api' }],
			['GITHUB_TOKEN', { input: 'github_token' }],
			['LOG_LEVEL', { template: 'info' }]
		]);
		expect(m.repos).toEqual([
			{
				reach: 'pack',
				workflow: null,
				state: null,
				name: 'app',
				input: 'app_repo',
				url: null,
				branch: null,
				dir: 'app'
			},
			{
				reach: 'pack',
				workflow: null,
				state: null,
				name: 'docs',
				input: null,
				url: 'https://github.com/acme/docs',
				branch: 'main',
				dir: 'docs'
			}
		]);
		expect(m.schedules).toEqual([
			{
				key: 'nightly',
				name: 'Nightly QA',
				workflow: 'qa',
				start: null,
				recurrence: { cron: '0 2 * * *' },
				only_when_previous_closed: false,
				title: 'Nightly QA',
				description: ''
			},
			{
				key: 'weekly-triage',
				name: 'Weekly triage',
				workflow: 'engineering',
				start: 'triage',
				recurrence: { every: 'weekly', on: 'mon', at: '09:00' },
				only_when_previous_closed: true,
				title: 'Triage for {{ date }}',
				description:
					'Sweep new bugs and assign priorities. Escalate anything unclear:\n{{ inputs.escalation }}\n'
			}
		]);
		expect(m.migrations).toEqual({
			'3': { renamed: { eng: 'engineering' }, removed: {} },
			'4': {
				renamed: { 'engineering/impl': 'engineering/implement' },
				removed: { 'engineering/qa-check': 'engineering/review' }
			}
		});
		expect(m.readme).toBe('# Engineering\n\nImplement, review and ship.\n');
		expect(m.changelog).toBe('## 4\n\n- Added QA.\n');
	});

	it('accepts a minimal pack, with no version (null)', async () => {
		const r = await parsePack(
			packFilesFromRecord({ 'pack.yaml': 'format: 1\nid: me/min\nname: Min\n' })
		);
		expect(r.errors).toEqual([]);
		expect(r.model?.manifest).toEqual({
			format: 1,
			id: 'me/min',
			name: 'Min',
			version: null,
			description: '',
			derived_from: null,
			inputs: {}
		});
		expect(r.model?.readme).toBeNull();
	});
});

describe('parsePack: pack.yaml', () => {
	it('requires pack.yaml', async () => {
		expect(await errorCodes({ 'pack.yaml': null })).toContain('missing_manifest');
	});
	it('refuses a newer format', async () => {
		expect(await errorCodes(edit('pack.yaml', 'format: 1', 'format: 2'))).toEqual([
			'format_too_new'
		]);
	});
	it('requires an integer format', async () => {
		expect(await errorCodes(edit('pack.yaml', 'format: 1', 'format: "1"'))).toContain(
			'invalid_format'
		);
	});
	it('checks the id', async () => {
		expect(await errorCodes(edit('pack.yaml', 'id: tbuckley/engineering', 'id: "-bad"'))).toContain(
			'invalid_id'
		);
	});
	it('checks the name', async () => {
		expect(await errorCodes(edit('pack.yaml', 'name: Engineering', 'name: ""'))).toContain(
			'invalid_name'
		);
	});
	it('checks the version', async () => {
		expect(await errorCodes(edit('pack.yaml', 'version: 4', 'version: 0'))).toContain(
			'invalid_version'
		);
	});
	it('warns on unknown keys', async () => {
		const r = await parseWith(edit('pack.yaml', 'version: 4', 'version: 4\nauthor: me'));
		expect(r.errors).toEqual([]);
		expect(r.model).not.toBeNull();
		expect(r.warnings.map((w) => w.code)).toEqual(['unknown_key']);
	});
	it('checks input names', async () => {
		expect(await errorCodes(edit('pack.yaml', '  reviewer:', '  Reviewer:'))).toContain(
			'invalid_input_name'
		);
	});
	it('checks input types', async () => {
		expect(
			await errorCodes(
				edit('pack.yaml', 'type: text\n    description: Who', 'type: number\n    description: Who')
			)
		).toContain('invalid_input');
	});
	it('refuses a secret default', async () => {
		expect(
			await errorCodes(
				edit(
					'pack.yaml',
					'description: A GitHub token with repo scope',
					'description: x\n    default: abc'
				)
			)
		).toContain('secret_default');
	});
	it('refuses a repo URL default', async () => {
		expect(
			await errorCodes(edit('pack.yaml', 'default_branch: main', 'default: https://x'))
		).toContain('repo_default');
	});
	it('checks a workflow default names a workflow (and state) in the pack', async () => {
		expect(
			await errorCodes(
				edit('pack.yaml', 'default: engineering/triage', 'default: engineering/nope')
			)
		).toEqual(['unknown_workflow']);
		expect(
			await errorCodes(edit('pack.yaml', 'default: engineering/triage', 'default: other'))
		).toEqual(['unknown_workflow']);
		expect(
			(await parseWith(edit('pack.yaml', 'default: engineering/triage', 'default: qa'))).errors
		).toEqual([]);
	});
});

describe('parsePack: files and YAML', () => {
	it('refuses non-text files outside skills', async () => {
		expect(await errorCodes({ 'shared/logo.png': 'png', 'notes.txt': 'x' })).toEqual([
			'stray_file',
			'stray_file'
		]);
	});
	it('refuses root Markdown other than README and CHANGELOG, and unknown YAML', async () => {
		expect(
			await errorCodes({ 'NOTES.md': 'x', 'extra.yaml': 'a: 1', 'docs/guide.md': 'x' })
		).toEqual(['unexpected_file', 'unexpected_file', 'unexpected_file']);
	});
	it('reports YAML syntax errors and duplicate keys', async () => {
		expect(await errorCodes({ 'shared/env.yaml': 'A: [1' })).toContain('invalid_yaml');
		expect(await errorCodes({ 'shared/env.yaml': 'A: x\nA: y\n' })).toContain('invalid_yaml');
	});
	it('caps non-skill text files', async () => {
		expect(await errorCodes({ 'README.md': 'x'.repeat(PACK_TEXT_FILE_MAX_BYTES + 1) })).toEqual([
			'file_too_large'
		]);
	});
	it('requires UTF-8', async () => {
		expect(
			await errorCodes({}, [{ path: 'project/bad.md', bytes: new Uint8Array([0xff, 0xfe, 0x41]) }])
		).toEqual(['invalid_utf8']);
	});
	it('reports path problems from normalization', async () => {
		expect(await errorCodes({ 'project/A.md': 'x', 'project/a.md': 'y' })).toEqual([
			'case_collision'
		]);
	});
});

describe('parsePack: prompts and skills', () => {
	it('refuses a prompt named journal', async () => {
		expect(await errorCodes({ 'workflows/engineering/journal.md': 'x' })).toEqual([
			'reserved_prompt_name'
		]);
	});
	it('caps prompt bodies', async () => {
		expect(await errorCodes({ 'project/big.md': 'x'.repeat(32 * 1024 + 1) })).toEqual([
			'prompt_too_large'
		]);
	});
	it('checks prompt frontmatter', async () => {
		expect(await errorCodes({ 'project/a.md': '---\norder: soon\n---\nx' })).toEqual([
			'invalid_frontmatter'
		]);
		expect(await errorCodes({ 'project/a.md': '---\norder: 1\nbody' })).toEqual([
			'invalid_frontmatter'
		]);
	});
	it('checks skill names', async () => {
		expect(
			await errorCodes({
				'project/skills/My_Skill/SKILL.md': '---\nname: My_Skill\ndescription: x\n---\n'
			})
		).toEqual(['invalid_skill_name']);
	});
	it('requires SKILL.md', async () => {
		expect(await errorCodes({ 'project/skills/empty/notes.md': 'x' })).toEqual([
			'missing_skill_md'
		]);
	});
	it('requires the SKILL.md name to match the folder', async () => {
		expect(
			await errorCodes(
				edit('project/skills/escalation/SKILL.md', 'name: escalation', 'name: escalate')
			)
		).toEqual(['skill_name_mismatch']);
	});
	it('requires a SKILL.md description', async () => {
		expect(
			await errorCodes(
				edit('project/skills/escalation/SKILL.md', 'description: How to escalate\n', '')
			)
		).toEqual(['invalid_frontmatter']);
	});
	it('refuses binary skill files', async () => {
		expect(
			await errorCodes({}, [
				{
					path: 'shared/skills/pr-hygiene/logo.png',
					bytes: new Uint8Array([0x89, 0x50, 0x00, 0xff])
				}
			])
		).toEqual(['binary_skill_file']);
	});
	it('caps skill file counts and sizes', async () => {
		const many: Record<string, string> = {};
		for (let i = 0; i < 20; i++) many[`shared/skills/pr-hygiene/f${i}.txt`] = 'x';
		expect(await errorCodes(many)).toEqual(['skill_too_large']);
		expect(
			await errorCodes({ 'shared/skills/pr-hygiene/big.txt': 'x'.repeat(100 * 1024) })
		).toEqual(['skill_too_large']);
	});
	it('only renders placeholders in skill Markdown', async () => {
		// check.sh in the fixture mentions an undeclared input and is fine;
		// the same text in a skill .md file is not.
		expect(
			await errorCodes({ 'shared/skills/pr-hygiene/notes.md': '{{ inputs.not_declared }}' })
		).toEqual(['unknown_input']);
	});
});

describe('parsePack: placeholders', () => {
	it('refuses unknown inputs in prompts, env, and schedules', async () => {
		expect(await errorCodes({ 'project/a.md': '{{ inputs.nope }}' })).toEqual(['unknown_input']);
		expect(await errorCodes({ 'shared/env.yaml': 'A: "{{ inputs.nope }}"' })).toEqual([
			'unknown_input'
		]);
		expect(
			await errorCodes(
				edit('schedules/nightly.yaml', 'title: Nightly QA', 'title: "{{ inputs.nope }}"')
			)
		).toEqual(['unknown_input']);
	});
	it('refuses secret inputs as placeholders', async () => {
		expect(await errorCodes({ 'project/a.md': 'token {{ inputs.github_token }}' })).toEqual([
			'secret_placeholder'
		]);
	});
	it('does not check escaped placeholders', async () => {
		const r = await parseWith({ 'project/a.md': '{{! inputs.github_token }} {{!! inputs.nope }}' });
		expect(r.errors).toEqual([]);
	});
	it('does not treat placeholders in workflow.yaml or repos.yaml as placeholders', async () => {
		const r = await parseWith(
			edit('workflows/qa/workflow.yaml', 'name: QA', 'name: "QA {{ inputs.nope }}"')
		);
		expect(r.errors).toEqual([]);
		expect(r.model!.workflows[1].name).toBe('QA {{ inputs.nope }}');
	});
});

describe('parsePack: env.yaml and repos.yaml', () => {
	it('checks env names', async () => {
		expect(await errorCodes({ 'project/env.yaml': 'lower: x' })).toEqual(['invalid_env_name']);
	});
	it('refuses reserved env names', async () => {
		expect(await errorCodes({ 'project/env.yaml': 'TINES_X: x\nPATH: /bin' })).toEqual([
			'reserved_env_name',
			'reserved_env_name'
		]);
	});
	it('refuses non-string env values', async () => {
		expect(await errorCodes({ 'project/env.yaml': 'A: 3' })).toEqual(['invalid_env_value']);
		expect(await errorCodes({ 'project/env.yaml': `A: "${'x'.repeat(16 * 1024 + 1)}"` })).toEqual([
			'invalid_env_value'
		]);
	});
	it('checks env input references', async () => {
		expect(await errorCodes({ 'project/env.yaml': 'A: { input: nope }' })).toEqual([
			'unknown_input'
		]);
		expect(await errorCodes({ 'project/env.yaml': 'A: { input: app_repo }' })).toEqual([
			'input_type_mismatch'
		]);
		expect((await parseWith({ 'project/env.yaml': 'A: { input: staging_url }' })).errors).toEqual(
			[]
		);
	});
	it('checks repos', async () => {
		expect(
			await errorCodes({ 'project/repos.yaml': 'x: { url: "http://example.com/x" }' })
		).toEqual(['invalid_repo']);
		expect(
			await errorCodes({
				'project/repos.yaml': 'x: { url: "https://example.com/x", input: app_repo }'
			})
		).toEqual(['invalid_repo']);
		expect(
			await errorCodes({ 'project/repos.yaml': 'x: { url: "https://example.com/x", dir: ../up }' })
		).toEqual(['invalid_repo']);
		expect(await errorCodes({ 'project/repos.yaml': 'x: { input: staging_url }' })).toEqual([
			'input_type_mismatch'
		]);
	});
});

describe('parsePack: workflows', () => {
	const wf = 'workflows/engineering/workflow.yaml';
	it('checks workflow keys', async () => {
		expect(
			await errorCodes({
				'workflows/9lives/workflow.yaml':
					'name: X\ninitial: a\nstates:\n  a: { name: A, category: done }\n'
			})
		).toContain('invalid_key');
	});
	it('requires workflow.yaml', async () => {
		expect(await errorCodes({ 'workflows/ops/overview.md': 'x' })).toEqual([
			'missing_workflow_yaml'
		]);
	});
	it('refuses inherits_from', async () => {
		expect(
			await errorCodes(edit(wf, 'category: done', 'category: done\n    inherits_from: x'))
		).toEqual(['inherits_from']);
	});
	it('refuses the workspace run scope, and other unknown scopes', async () => {
		expect(await errorCodes(edit(wf, 'run_scope: issue', 'run_scope: workspace'))).toEqual([
			'workspace_run_scope'
		]);
		expect(await errorCodes(edit(wf, 'run_scope: issue', 'run_scope: global'))).toEqual([
			'invalid_run_scope'
		]);
	});
	it('checks categories', async () => {
		expect(await errorCodes(edit(wf, 'category: awaiting_human', 'category: waiting'))).toEqual([
			'invalid_category'
		]);
	});
	it('refuses duplicate transition names, case-insensitively', async () => {
		expect(
			await errorCodes(edit(wf, 'Blocked: triage', 'Blocked: triage\n      blocked: review'))
		).toEqual(['duplicate_transition']);
	});
	it('refuses unknown targets and self transitions', async () => {
		expect(await errorCodes(edit(wf, 'Blocked: triage', 'Blocked: nowhere'))).toEqual([
			'unknown_state'
		]);
		expect(await errorCodes(edit(wf, 'Blocked: triage', 'Blocked: implement'))).toEqual([
			'self_transition'
		]);
	});
	it('requires a backlog or active initial state', async () => {
		expect(await errorCodes(edit(wf, 'initial: triage', 'initial: done'))).toEqual([
			'invalid_initial_state'
		]);
		expect(await errorCodes(edit(wf, 'initial: triage', 'initial: nope'))).toEqual([
			'invalid_initial_state'
		]);
	});
	it('requires unique state names', async () => {
		expect(await errorCodes(edit(wf, 'name: Human review', 'name: Implement'))).toEqual([
			'duplicate_state_name'
		]);
	});
	it('checks state keys', async () => {
		expect(
			await errorCodes(edit(wf, '  done:\n    name: Done', '  Done2:\n    name: Done'))
		).toContain('invalid_key');
	});
	it('validates requirements as the API does (the spec example pull_request is not a valid artifact name)', async () => {
		expect(await errorCodes(edit(wf, '[pull-request]', '[pull_request]'))).toEqual([
			'invalid_requirement'
		]);
		expect(await errorCodes(edit(wf, '[pull-request]', '[a, a]'))).toEqual(['invalid_requirement']);
		expect(
			await errorCodes(
				edit(wf, '[pull-request]', '[{ artifact: a, type: link, content_type: text/ }]')
			)
		).toEqual(['invalid_requirement']);
	});
	it('warns on a non-done state with no transitions', async () => {
		const r = await parseWith(
			edit(wf, '    transitions:\n      Request changes: implement\n      Approve: done\n', '')
		);
		expect(r.errors).toEqual([]);
		expect(r.warnings.map((w) => w.code)).toEqual(['dead_end_state']);
	});
	it('refuses a state folder for a state not in workflow.yaml', async () => {
		expect(
			await errorCodes({ 'workflows/engineering/states/deploy/instructions.md': 'x' })
		).toEqual(['unknown_state_folder']);
	});
	it('warns on shared/ in a pack with no workflows', async () => {
		const r = await parsePack(
			packFilesFromRecord({ 'pack.yaml': 'format: 1\nid: me/ctx\nname: Ctx\n', 'shared/a.md': 'x' })
		);
		expect(r.errors).toEqual([]);
		expect(r.warnings.map((w) => w.code)).toEqual(['shared_without_workflows']);
	});
});

describe('parsePack: schedules and migrations', () => {
	const s = 'schedules/weekly-triage.yaml';
	it('requires the workflow to be in the pack', async () => {
		expect(await errorCodes(edit(s, 'workflow: engineering', 'workflow: ops'))).toContain(
			'unknown_workflow'
		);
	});
	it('requires the start state to be in the workflow', async () => {
		expect(await errorCodes(edit(s, 'start: triage', 'start: test'))).toEqual(['unknown_state']);
	});
	it('compiles the recurrence', async () => {
		expect(await errorCodes(edit(s, 'on: mon', 'on: someday'))).toEqual(['invalid_recurrence']);
		expect(await errorCodes(edit('schedules/nightly.yaml', '0 2 * * *', '* 2 * * *'))).toEqual([
			'invalid_recurrence'
		]);
		expect(
			await errorCodes(
				edit(
					'schedules/nightly.yaml',
					'{ cron: "0 2 * * *" }',
					'{ cron: "0 2 * * *", every: daily }'
				)
			)
		).toEqual(['invalid_recurrence']);
	});
	it('checks migrations', async () => {
		expect(await errorCodes({ 'migrations.yaml': 'v4:\n  renamed: { a: b }\n' })).toEqual([
			'invalid_migration'
		]);
		expect(await errorCodes({ 'migrations.yaml': '"4":\n  renamed: { a: b/c }\n' })).toEqual([
			'invalid_migration'
		]);
		expect(await errorCodes({ 'migrations.yaml': '"4":\n  removed: { "A/B": b/c }\n' })).toEqual([
			'invalid_migration'
		]);
	});
});
