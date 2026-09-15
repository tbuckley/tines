import { describe, expect, it } from 'vitest';
import { publicTextModel, renderedPublicTextWordCount } from './public-text.js';

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
});
