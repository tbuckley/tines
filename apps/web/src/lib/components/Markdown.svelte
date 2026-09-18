<script lang="ts">
	import { micromark } from 'micromark';
	import { gfm, gfmHtml } from 'micromark-extension-gfm';
	import { inertMarkdownImages } from '$lib/components/library/package-text';

	let {
		source,
		class: className = '',
		inertImages = false
	}: { source: string; class?: string; inertImages?: boolean } = $props();

	// micromark's defaults (allowDangerousHtml/Protocol off) escape raw HTML
	// and drop javascript: links, so the output is XSS-safe for agent input.
	// `inertImages` swaps every <img> for a text placeholder before the HTML
	// reaches the document, so reviewed content never fetches a remote resource.
	const html = $derived.by(() => {
		const rendered = micromark(source, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
		return inertImages ? inertMarkdownImages(rendered) : rendered;
	});
</script>

<div class="markdown {className}">
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized above -->
	{@html html}
</div>
