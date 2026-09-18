import { describe, expect, it } from 'vitest';
import { lintHtmlArtifact, siteEntry } from './artifact-site.js';

describe('siteEntry', () => {
	it('treats HTML file and text artifacts as sites served at the root', () => {
		expect(siteEntry('file', 'text/html')).toBe('');
		expect(siteEntry('text', 'text/html; charset=utf-8')).toBe('');
		expect(siteEntry('file', 'TEXT/HTML')).toBe('');
	});

	it('is not a site for other content types or reference artifacts', () => {
		expect(siteEntry('file', 'image/png')).toBeNull();
		expect(siteEntry('text', 'text/markdown')).toBeNull();
		expect(siteEntry('file', null)).toBeNull();
		expect(siteEntry('link', 'text/html')).toBeNull();
		expect(siteEntry('pr', 'text/html')).toBeNull();
	});

	it('needs a root index.html for a folder', () => {
		expect(siteEntry('folder', null, [{ path: 'index.html' }, { path: 'app.js' }])).toBe(
			'index.html'
		);
		expect(siteEntry('folder', null, [{ path: 'docs/index.html' }])).toBeNull();
		expect(siteEntry('folder', null, [])).toBeNull();
	});
});

describe('lintHtmlArtifact', () => {
	const page = (head: string, body = '<h1>hi</h1>') =>
		`<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
	const viewport = '<meta name="viewport" content="width=device-width, initial-scale=1">';

	it('passes a self-contained responsive page', () => {
		expect(lintHtmlArtifact(page(`${viewport}<style>body{color:red}</style>`))).toEqual([]);
	});

	it('warns when the viewport meta is missing or not device-width', () => {
		expect(lintHtmlArtifact(page('<title>x</title>'))[0]).toContain('viewport');
		expect(lintHtmlArtifact(page('<meta name="viewport" content="initial-scale=1">'))[0]).toContain(
			'viewport'
		);
	});

	it('warns about external scripts, styles and imports', () => {
		const external = lintHtmlArtifact(
			page(`${viewport}<script src="https://cdn.example.com/react.js"></script>`)
		);
		expect(external).toHaveLength(1);
		expect(external[0]).toContain('https://cdn.example.com/react.js');
		expect(external[0]).toContain('blocked by the sandbox policy');

		expect(
			lintHtmlArtifact(page(`${viewport}<link rel="stylesheet" href="//cdn.example.com/t.css">`))[0]
		).toContain('//cdn.example.com/t.css');
		expect(
			lintHtmlArtifact(page(`${viewport}<style>@import url("https://x.test/a.css");</style>`))[0]
		).toContain('https://x.test/a.css');
	});

	it('accepts relative references to sibling files', () => {
		expect(
			lintHtmlArtifact(
				page(`${viewport}<link rel="stylesheet" href="./styles.css"><script src="app.js"></script>`)
			)
		).toEqual([]);
	});
});
