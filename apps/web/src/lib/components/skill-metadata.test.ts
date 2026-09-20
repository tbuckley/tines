import {
	CONTEXT_DESCRIPTION_MAX_LENGTH,
	CONTEXT_NAME_MAX_LENGTH,
	SKILL_MAX_TOTAL_BYTES
} from '@tines/shared';
import { describe, expect, it } from 'vitest';
import { readSkillMetadata } from './skill-metadata';

const skill = (frontMatter: string, newline = '\n') =>
	`---${newline}${frontMatter}${newline}---${newline}# Instructions`;

describe('readSkillMetadata', () => {
	it('reads YAML string syntax, a BOM, CRLF, unrelated keys, and an EOF delimiter', async () => {
		expect(
			await readSkillMetadata(
				'\ufeff---\r\nname: invitation-review\r\ndescription: "Review: \\u2713"\r\nextra: true\r\n---'
			)
		).toEqual({ name: 'invitation-review', description: 'Review: ✓' });
		expect(
			await readSkillMetadata(skill("name: 'quoted-skill'\ndescription: 'A # literal comment'"))
		).toEqual({ name: 'quoted-skill', description: 'A # literal comment' });
		expect(
			await readSkillMetadata(skill('name: folded-skill\ndescription: >-\n  folded\n  line'))
		).toEqual({ name: 'folded-skill', description: 'folded line' });
	});

	it('returns no candidates for invalid or unsupported documents', async () => {
		const tooLarge = `name: valid-name\npadding: ${'x'.repeat(SKILL_MAX_TOTAL_BYTES)}`;
		for (const content of [
			'name: later\n---\ndescription: not leading\n---',
			'---\nname: unclosed',
			skill('[name, description]'),
			skill('name: one\nname: two'),
			skill('name: [unterminated'),
			skill('base: &base value\nname: *base'),
			skill('name: !!str tagged'),
			skill('%YAML 1.2\nname: directed'),
			skill('base: &base { description: inherited }\n<<: *base\nname: merged'),
			skill(tooLarge)
		]) {
			expect(await readSkillMetadata(content), content.slice(0, 40)).toEqual({});
		}
	});

	it('validates fields independently without coercion', async () => {
		expect(await readSkillMetadata(skill('name: valid-name\ndescription: 42'))).toEqual({
			name: 'valid-name'
		});
		expect(await readSkillMetadata(skill('name: 42\ndescription: A valid description'))).toEqual({
			description: 'A valid description'
		});
		for (const value of ['null', 'true', '[value]', '{ nested: value }']) {
			expect(await readSkillMetadata(skill(`name: ${value}`))).toEqual({});
		}
		expect(await readSkillMetadata(skill("name: '123'"))).toEqual({ name: '123' });
	});

	it('enforces name and one-line description boundaries', async () => {
		const exactName = 'a'.repeat(CONTEXT_NAME_MAX_LENGTH);
		expect(exactName).toHaveLength(CONTEXT_NAME_MAX_LENGTH);
		expect(await readSkillMetadata(skill(`name: '  ${exactName}  '`))).toEqual({
			name: exactName
		});
		for (const name of ['', '   ', 'Uppercase', 'bad_name', `${exactName}a`]) {
			expect(await readSkillMetadata(skill(`name: '${name}'`))).toEqual({});
		}

		const exactDescription = 'd'.repeat(CONTEXT_DESCRIPTION_MAX_LENGTH);
		expect(await readSkillMetadata(skill(`description: '${exactDescription}'`))).toEqual({
			description: exactDescription
		});
		for (const frontMatter of [
			"description: '   '",
			`description: '${exactDescription}d'`,
			'description: "first\\nsecond"',
			'description: |-\n  first\n  second'
		]) {
			expect(await readSkillMetadata(skill(frontMatter))).toEqual({});
		}
	});

	it('does not mutate the imported source', async () => {
		const content = skill('name: source-name\ndescription: Source description');
		const before = content.slice();
		await readSkillMetadata(content);
		expect(content).toBe(before);
	});
});
