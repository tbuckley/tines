import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CliError } from './errors.js';
import {
	assertNewStatesHavePrompts,
	parseFileSpec,
	parseIssueRef,
	parseJsonObject,
	parseScheduleRef,
	parseTargetSpec
} from './refs.js';

const dir = mkdtempSync(join(tmpdir(), 'tines-refs-'));
const bodyFile = join(dir, 'body.md');
writeFileSync(bodyFile, '- a lesson\n');

describe('parseIssueRef', () => {
	it.each([
		['Proj/1', { project: 'Proj', number: 1 }],
		['Proj/42', { project: 'Proj', number: 42 }],
		// The project half is greedy, so a project containing a slash still parses.
		['a/b/2', { project: 'a/b', number: 2 }]
	])('parses %s', (ref, expected) => {
		expect(parseIssueRef(ref)).toEqual(expected);
	});

	it.each(['badref', 'Proj/', '/1', 'Proj/abc', 'Proj/1x', ''])('rejects %j', (ref) => {
		expect(() => parseIssueRef(ref)).toThrow(
			new CliError(`issue reference must look like <project>/<number>, got "${ref}"`)
		);
	});
});

describe('parseScheduleRef', () => {
	it.each([
		['Proj/nightly', { project: 'Proj', name: 'nightly' }],
		// Only the FIRST slash separates, so a name may contain slashes.
		['Proj/a/b', { project: 'Proj', name: 'a/b' }]
	])('parses %s', (ref, expected) => {
		expect(parseScheduleRef(ref)).toEqual(expected);
	});

	it.each(['nightly', 'Proj/', '/nightly', ''])('rejects %j', (ref) => {
		expect(() => parseScheduleRef(ref)).toThrow(
			`schedule reference must look like <project>/<name>, got "${ref}"`
		);
	});
});

describe('parseFileSpec', () => {
	it('maps a workspace path to a local file body', () => {
		expect(parseFileSpec(`SKILL.md=@${bodyFile}`)).toEqual({
			path: 'SKILL.md',
			content: '- a lesson\n'
		});
	});

	it('splits on the first = so the local path may contain one', () => {
		const eq = join(dir, 'a=b.md');
		writeFileSync(eq, 'x');
		expect(parseFileSpec(`docs/x.md=@${eq}`)).toEqual({ path: 'docs/x.md', content: 'x' });
	});

	it.each(['SKILL.md', '=@x', 'SKILL.md='])('rejects %j', (spec) => {
		expect(() => parseFileSpec(spec)).toThrow(
			`--file must look like <path>=@<local-file>, got "${spec}"`
		);
	});

	it('rejects an inline body: content always comes from a file', () => {
		expect(() => parseFileSpec('SKILL.md=hello')).toThrow(
			'skill file content always comes from a local file: --file SKILL.md=@<local-file>'
		);
	});
});

describe('parseJsonObject', () => {
	it('parses an object', () => {
		expect(parseJsonObject('{"a":1}', 'stdin')).toEqual({ a: 1 });
	});

	it('names the source in a syntax error', () => {
		expect(() => parseJsonObject('{oops', '--file x.json')).toThrow(/^invalid JSON from --file x/);
	});

	it.each(['[1,2]', '"str"', '3', 'null'])('rejects non-object JSON %j', (raw) => {
		expect(() => parseJsonObject(raw, 'stdin')).toThrow('expected a JSON object from stdin');
	});
});

describe('parseTargetSpec', () => {
	it('parses a bare runner name', () => {
		expect(parseTargetSpec('macbook')).toEqual({ name: 'macbook' });
	});

	it('parses <runner>:<tier>', () => {
		expect(parseTargetSpec('macbook:balanced')).toEqual({ name: 'macbook', tier: 'balanced' });
	});

	it('rejects an unknown tier, listing the valid ones', () => {
		expect(() => parseTargetSpec('macbook:turbo')).toThrow(/unknown tier "turbo"/);
	});
});

describe('assertNewStatesHavePrompts', () => {
	it('passes when every new state has a prompt', () => {
		expect(() =>
			assertNewStatesHavePrompts([{ name: 'Design', prompt: 'do design' }], undefined)
		).not.toThrow();
	});

	it('ignores existing states, which inherit their prompt', () => {
		expect(() => assertNewStatesHavePrompts([{ id: 'st_1', name: 'Design' }], undefined)).not.toThrow();
	});

	it('names every promptless new state', () => {
		expect(() =>
			assertNewStatesHavePrompts([{ name: 'A' }, { name: 'B', prompt: '  ' }], undefined)
		).toThrow(/new states "A", "B" have no initial prompt/);
	});

	it('is skipped by --no-prompts', () => {
		expect(() => assertNewStatesHavePrompts([{ name: 'A' }], false)).not.toThrow();
	});
});
