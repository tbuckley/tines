<script lang="ts">
	import { cn } from '$lib/utils.js';

	let { class: className }: { class?: string } = $props();
</script>

<div data-slot="skeleton" class={cn('bg-muted animate-pulse rounded-md', className)}></div>
