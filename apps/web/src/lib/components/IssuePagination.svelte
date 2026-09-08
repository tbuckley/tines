<script lang="ts">
	import type { IssuePagination } from '$lib/server/issue-pagination';
	import { buttonVariants } from '$lib/components/ui/button';

	let { pagination, itemCount }: { pagination: IssuePagination; itemCount: number } = $props();
	const label = $derived(`${itemCount} issue${itemCount === 1 ? '' : 's'} on this page`);
</script>

{#if pagination.previousHref || pagination.nextHref || pagination.bounded}
	<nav aria-label="Issue pagination" class="mt-4 flex flex-wrap items-center justify-between gap-3">
		<p class="text-muted-foreground w-full text-sm sm:w-auto" aria-live="polite">{label}</p>
		<div class="flex gap-2">
			{#if pagination.previousHref}
				<a
					href={pagination.previousHref}
					class={buttonVariants({ variant: 'outline', size: 'sm' }) + ' min-h-11'}>Previous</a
				>
			{:else}
				<span class={buttonVariants({ variant: 'outline', size: 'sm' }) + ' min-h-11 opacity-50'}
					>Previous</span
				>
			{/if}
			{#if pagination.nextHref}
				<a
					href={pagination.nextHref}
					class={buttonVariants({ variant: 'outline', size: 'sm' }) + ' min-h-11'}>Next</a
				>
			{:else}
				<span class={buttonVariants({ variant: 'outline', size: 'sm' }) + ' min-h-11 opacity-50'}
					>Next</span
				>
			{/if}
		</div>
		{#if pagination.empty}
			<a href={pagination.firstHref} class="text-sm underline underline-offset-2">First page</a>
		{/if}
	</nav>
{/if}
