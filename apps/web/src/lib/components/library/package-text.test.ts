import { describe, expect, it } from 'vitest';
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import {
	declaredOccurrences,
	inertMarkdownImages,
	markDeclaredOccurrences,
	splitMarkers
} from './package-text';

const tokens = [{ token: '{{target_name:TARGET}}', inputId: 'input:author:1' }];

describe('declaredOccurrences', () => {
	it('skips escaped literals and keeps the unescaped use', () => {
		const text = 'Use {{target_name:TARGET}} once; \\{{target_name:TARGET}} stays literal.';
		expect(declaredOccurrences(text, tokens)).toEqual([
			{ start: 4, end: 26, token: '{{target_name:TARGET}}', inputId: 'input:author:1' }
		]);
	});

	it('returns nothing when every occurrence is escaped', () => {
		expect(declaredOccurrences('\\{{target_name:TARGET}}', tokens)).toEqual([]);
	});

	it('drops overlapping matches after the first in source order', () => {
		const overlapping = [
			{ token: 'ab', inputId: 'a' },
			{ token: 'bc', inputId: 'b' }
		];
		expect(declaredOccurrences('abc', overlapping).map((item) => item.inputId)).toEqual(['a']);
	});
});

describe('markDeclaredOccurrences', () => {
	it('replaces only substitutable occurrences with indexed markers', () => {
		const text = 'A {{target_name:TARGET}} B \\{{target_name:TARGET}} C {{target_name:TARGET}}';
		const { source, occurrences } = markDeclaredOccurrences(text, tokens);
		expect(source).toBe('A 0 B \\{{target_name:TARGET}} C 1');
		expect(occurrences).toHaveLength(2);
		expect(splitMarkers(source)).toEqual([
			{ text: 'A ' },
			{ index: 0 },
			{ text: ' B \\{{target_name:TARGET}} C ' },
			{ index: 1 }
		]);
	});

	it('keeps markers intact through Markdown rendering while escapes render as text', () => {
		const text = '**{{target_name:TARGET}}** and \\{{target_name:TARGET}}';
		const { source } = markDeclaredOccurrences(text, tokens);
		const html = micromark(source, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
		expect(html).toBe('<p><strong>0</strong> and {{target_name:TARGET}}</p>');
	});
});

describe('inertMarkdownImages', () => {
	it('replaces inline and reference images with labelled placeholders', () => {
		const html = micromark(
			'![remote pixel](https://example.invalid/auto-fetch.png "title") ![r][ref]\n\n[ref]: https://example.invalid/q.png',
			{ extensions: [gfm()], htmlExtensions: [gfmHtml()] }
		);
		const inert = inertMarkdownImages(html);
		expect(inert).not.toContain('<img');
		expect(inert).toContain(
			'<span class="markdown-inert-image" role="img" aria-label="Image not loaded: remote pixel — https://example.invalid/auto-fetch.png">Image (not loaded): remote pixel — https://example.invalid/auto-fetch.png</span>'
		);
		expect(inert).toContain('Image (not loaded): r — https://example.invalid/q.png');
	});

	it('keeps encoded attribute values encoded and handles a missing alt', () => {
		expect(
			inertMarkdownImages('<img src="https://x.invalid/a?b=1&amp;c=&quot;2&quot;" alt="" />')
		).toBe(
			'<span class="markdown-inert-image" role="img" aria-label="Image not loaded: https://x.invalid/a?b=1&amp;c=&quot;2&quot;">Image (not loaded): https://x.invalid/a?b=1&amp;c=&quot;2&quot;</span>'
		);
	});

	it('leaves links and code untouched', () => {
		const html = '<p><a href="https://x.invalid">l</a> <code>&lt;img src=x&gt;</code></p>';
		expect(inertMarkdownImages(html)).toBe(html);
	});
});
