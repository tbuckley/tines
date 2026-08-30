<script lang="ts">
	import type { Snippet } from 'svelte';
	import IconAlertTriangle from '@tabler/icons-svelte/icons/alert-triangle';
	import IconLock from '@tabler/icons-svelte/icons/lock';
	import IconSearchOff from '@tabler/icons-svelte/icons/search-off';

	let {
		status,
		message = null,
		path = null,
		actions
	}: {
		status: number;
		message?: string | null;
		path?: string | null;
		actions?: Snippet;
	} = $props();

	// Kit's own default messages ("Not Found", "Internal Error") only repeat the
	// heading, so they are dropped in favour of the fallback copy below; a
	// message a load wrote itself ("Issue #9999 does not exist in …") is shown.
	const BOILERPLATE = new Set(['not found', 'internal error', 'error', 'forbidden', 'unauthorized']);

	const detail = $derived(
		message && !BOILERPLATE.has(message.trim().toLowerCase()) ? message.trim() : null
	);

	const heading = $derived(
		status === 404
			? 'Page not found'
			: status === 403
				? 'You do not have access to this'
				: status === 401
					? 'You need to sign in'
					: status >= 500
						? 'Something went wrong'
						: 'That did not work'
	);

	const fallback = $derived(
		status === 404
			? 'This page does not exist. It may have been renamed or deleted, or the link may be wrong.'
			: status >= 500
				? 'The server hit an unexpected error. Reloading often clears it.'
				: 'The page could not be loaded.'
	);

	const Icon = $derived(
		status === 404 ? IconSearchOff : status === 401 || status === 403 ? IconLock : IconAlertTriangle
	);
</script>

<div class="mx-auto flex w-full max-w-md flex-col items-center gap-5 py-12 text-center sm:py-20">
	<div class="bg-muted text-muted-foreground flex size-14 items-center justify-center rounded-2xl">
		<Icon size={28} stroke={1.5} />
	</div>
	<div class="flex flex-col gap-2">
		<p class="text-muted-foreground font-mono text-xs">Error {status}</p>
		<h1 class="text-2xl font-semibold tracking-tight text-balance">{heading}</h1>
		<p class="text-muted-foreground line-clamp-4 text-sm text-balance">{detail ?? fallback}</p>
		{#if path}
			<p class="text-muted-foreground/70 truncate font-mono text-xs">{path}</p>
		{/if}
	</div>
	{#if actions}
		<div class="flex flex-wrap items-center justify-center gap-2">{@render actions()}</div>
	{/if}
</div>
