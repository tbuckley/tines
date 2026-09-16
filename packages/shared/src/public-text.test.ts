import { describe, expect, it } from 'vitest';
import {
	declaredPublicTextOccurrences,
	publicTextModel,
	renderedPublicTextWordCount,
	truncatePublicTextModel
} from './public-text.js';

describe('public text rendering model', () => {
	it('keeps only text semantics and explicit http links', () => {
		const model = publicTextModel(
			'# Review\n\nHello **team** [site](https://example.test/a?q=1) [bad](javascript:alert(1)) <img src="https://tracker.test/p">'
		);
		expect(model).toEqual([
			{ kind: 'heading', depth: 1, spans: [{ text: 'Review' }] },
			{
				kind: 'paragraph',
				quote_depth: 0,
				spans: [
					{ text: 'Hello ' },
					{ text: 'team', strong: true },
					{ text: ' ' },
					{ text: 'site', href: 'https://example.test/a?q=1' },
					{ text: ' ' },
					{ text: 'bad' },
					{ text: ' ' },
					{ text: '<img src="https://tracker.test/p">' }
				]
			}
		]);
	});

	it('suppresses media even when malformed stored Markdown reaches the reader', () => {
		const serialized = JSON.stringify(
			publicTextModel('before ![secret](https://tracker.test/p) after')
		);
		expect(serialized).toContain('[image suppressed]');
		expect(serialized).not.toContain('tracker.test');
	});

	it('renders URLs with embedded credentials as inert text', () => {
		const serialized = JSON.stringify(
			publicTextModel('[destination](https://user:secret@example.test/path)')
		);
		expect(serialized).toContain('destination');
		expect(serialized).not.toContain('href');
		expect(serialized).not.toContain('secret');
	});

	it('counts rendered words across style boundaries and excludes link destinations', () => {
		expect(renderedPublicTextWordCount('a**b**c [label](https://example.test/hidden-path)')).toBe(
			2
		);
		expect(renderedPublicTextWordCount('`one two`\n\n| a | b |\n| - | - |\n| c | d |')).toBe(6);
	});

	it('marks only exact unescaped declared uses before Markdown parsing', () => {
		const uses = [{ id: 'use:1', input_id: 'input:1', token: '{{label:qa}}' }];
		const serialized = JSON.stringify(
			publicTextModel(
				'**{{label:qa}}** \\{{label:qa}} \uE0000\uE000 [`{{label:qa}}`](https://example.test)',
				{ uses }
			)
		);
		expect(serialized.match(/"use_id":"use:1"/g)).toHaveLength(2);
		expect(serialized).toContain('\uE0000\uE000');
		expect(serialized).not.toContain('https://example.test/');
		const linkedToken = publicTextModel('[{{label:qa}}](https://example.test)', { uses })[0];
		expect(linkedToken).toMatchObject({
			kind: 'paragraph',
			spans: [{ text: '{{label:qa}}', token: { use_id: 'use:1', input_id: 'input:1' } }]
		});
	});

	it('preserves reference links, nested list depth, table styles and fenced-code tokens', () => {
		const uses = [{ id: 'use:1', input_id: 'input:1', token: '{{label:qa}}' }];
		const model = publicTextModel(
			'- [**Guide**][guide]\n  - nested *item*\n\n| Head | Value |\n| - | - |\n| **A** | [B][guide] |\n\n```\n{{label:qa}}\n```\n\n[guide]: https://example.test/docs',
			{ uses }
		);
		expect(model.filter((block) => block.kind === 'list_item').map((block) => block.depth)).toEqual(
			[0, 1]
		);
		expect(JSON.stringify(model)).toContain('https://example.test/docs');
		expect(JSON.stringify(model)).toContain('"strong":true');
		expect(model.find((block) => block.kind === 'code')).toMatchObject({
			spans: [{ token: { use_id: 'use:1' } }]
		});
	});

	it('gives repeated declared occurrences unique navigation identities', () => {
		const uses = [{ id: 'use:1', input_id: 'input:1', token: 'TOKEN' }];
		const tokens = publicTextModel('TOKEN then TOKEN', { uses })
			.flatMap((block) => ('spans' in block ? block.spans : []))
			.map((span) => span.token?.occurrence_id)
			.filter(Boolean);
		expect(tokens).toEqual(['use:1:0', 'use:1:1']);
	});

	it('uses the canonical immediate-backslash escape rule for zero through three slashes', () => {
		const use = { id: 'use:1', input_id: 'input:1', token: '{{a:}}', value: 'VALUE' };
		const source = '{{a:}} / \\{{a:}} / \\\\{{a:}} / \\\\\\{{a:}}';
		expect(declaredPublicTextOccurrences(source, [use])).toHaveLength(1);
		const text = publicTextModel(source, { format: 'text', uses: [use] })[0];
		expect(text).toMatchObject({
			kind: 'paragraph',
			spans: [
				{ text: 'VALUE', token: { occurrence_id: 'use:1:0' } },
				{ text: ' / {{a:}} / \\{{a:}} / \\\\{{a:}}' }
			]
		});
	});

	it('parses resolved Markdown while retaining provenance without recursive substitution', () => {
		const model = publicTextModel('# {{a:}} + {{b:}}', {
			uses: [
				{ id: 'use:a', input_id: 'input:a', token: '{{a:}}', value: '**bold** {{b:}}' },
				{ id: 'use:b', input_id: 'input:b', token: '{{b:}}', value: '世界' }
			]
		});
		expect(model).toMatchObject([
			{
				kind: 'heading',
				spans: [
					{ text: 'bold', strong: true, token: { occurrence_id: 'use:a:0' } },
					{ text: ' {{b:}}', token: { occurrence_id: 'use:a:0' } },
					{ text: ' + ' },
					{ text: '世界', token: { occurrence_id: 'use:b:0' } }
				]
			}
		]);
	});

	it('retains empty values and values in Markdown destinations as editable occurrences', () => {
		const uses = [
			{ id: 'use:url', input_id: 'input:url', token: '{{url:}}', value: 'https://example.test/x' },
			{ id: 'use:empty', input_id: 'input:empty', token: '{{empty:}}', value: '' }
		];
		const serialized = JSON.stringify(publicTextModel('[go]({{url:}}) {{empty:}}', { uses }));
		expect(serialized).toContain('https://example.test/x');
		expect(serialized).toContain('"occurrence_id":"use:url:0"');
		expect(serialized).toContain('"occurrence_id":"use:empty:0"');
	});

	it('can preserve the labelled inert-image placeholder for author review', () => {
		const serialized = JSON.stringify(
			publicTextModel('![diagram](https://example.test/diagram.png)', { labelImages: true })
		);
		expect(serialized).toContain('Image (not loaded): diagram — https://example.test/diagram.png');
	});

	it('truncates at joined rendered-word boundaries across adjacent styles', () => {
		const source = `${Array.from({ length: 99 }, (_, index) => `w${index}`).join(' ')} a**b**c tail`;
		const cut = truncatePublicTextModel(publicTextModel(source), 100);
		const text = cut
			.flatMap((block) => ('spans' in block ? block.spans : []))
			.map((span) => span.text)
			.join('');
		expect(text).toContain('abc');
		expect(text).not.toContain('tail');
		expect(renderedPublicTextWordCount(text)).toBe(100);
	});
});
