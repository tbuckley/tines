<script lang="ts">
	import { micromark } from 'micromark';
	import { gfm, gfmHtml } from 'micromark-extension-gfm';

	let { source, class: className = '' }: { source: string; class?: string } = $props();

	// micromark's defaults (allowDangerousHtml/Protocol off) escape raw HTML
	// and drop javascript: links, so the output is XSS-safe for agent input.
	const html = $derived(
		micromark(source, { extensions: [gfm()], htmlExtensions: [gfmHtml()] })
	);
</script>

<div class="markdown {className}">
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized above -->
	{@html html}
</div>
