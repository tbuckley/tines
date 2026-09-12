<script lang="ts">
	let {
		text,
		tokens = [],
		onToken
	}: {
		text: string;
		tokens?: { token: string; inputId: string }[];
		onToken?: (id: string, trigger: HTMLElement) => void;
	} = $props();
	let expanded = $state(false);
	const words = $derived(text.trim() ? text.trim().split(/\s+/).length : 0);
	const shown = $derived.by(() => {
		if (expanded || words <= 115) return text;
		const matches = [...text.matchAll(/\S+/g)];
		const end = matches[Math.min(99, matches.length - 1)];
		let offset = (end?.index ?? 0) + (end?.[0].length ?? 0);
		for (const item of tokens) {
			const start = text.lastIndexOf(item.token, offset);
			if (start >= 0 && start < offset && start + item.token.length > offset)
				offset = start + item.token.length;
		}
		return text.slice(0, offset);
	});
	const pieces = $derived.by(() => {
		const matches: { start: number; end: number; token: string; inputId: string }[] = [];
		for (const item of tokens) {
			let from = 0;
			while (from < shown.length) {
				const start = shown.indexOf(item.token, from);
				if (start < 0) break;
				if (start === 0 || shown[start - 1] !== '\\')
					matches.push({ start, end: start + item.token.length, ...item });
				from = start + item.token.length;
			}
		}
		matches.sort((a, b) => a.start - b.start);
		const result: Array<{ text: string; inputId?: string }> = [];
		let at = 0;
		for (const match of matches) {
			if (match.start < at) continue;
			result.push({ text: shown.slice(at, match.start) });
			result.push({ text: match.token, inputId: match.inputId });
			at = match.end;
		}
		result.push({ text: shown.slice(at) });
		return result;
	});
</script>

<div class="bg-muted/20 rounded-md border">
	<pre
		class="max-w-full p-3 font-mono text-xs leading-5 break-words whitespace-pre-wrap">{#each pieces as piece}{#if piece.inputId}<button
					type="button"
					class="bg-primary/10 text-primary rounded px-0.5 font-mono underline underline-offset-2"
					onclick={(event) => onToken?.(piece.inputId!, event.currentTarget)}
					aria-label="Show declaration for {piece.text}">{piece.text}</button
				>{:else}{piece.text}{/if}{/each}{#if words > 115 && !expanded}<span aria-hidden="true"
				>…</span
			>{/if}</pre>
	{#if words > 115}
		<button
			type="button"
			class="text-primary min-h-10 border-t px-3 text-xs font-medium hover:underline"
			onclick={() => (expanded = !expanded)}
			>{expanded ? 'Show snippet' : `Show all ${words} words`}</button
		>
	{/if}
</div>
