<script module lang="ts">
	import IconAlertTriangle from '@tabler/icons-svelte/icons/alert-triangle';
	import IconCircleCheck from '@tabler/icons-svelte/icons/circle-check';
	import IconCircleX from '@tabler/icons-svelte/icons/circle-x';
	import type { RunOutcomeTone } from '$lib/format';

	/** The one glyph per run outcome tone — the Activity feed and run rows both read it. */
	export const RUN_OUTCOME_ICONS = {
		success: IconCircleCheck,
		warning: IconAlertTriangle,
		failure: IconCircleX
	} satisfies Record<RunOutcomeTone, typeof IconCircleCheck>;
</script>

<script lang="ts">
	let { tone, class: className = '' }: { tone: RunOutcomeTone; class?: string } = $props();

	let Icon = $derived(RUN_OUTCOME_ICONS[tone]);
</script>

<span
	class="inline-flex shrink-0 {className}"
	aria-hidden="true"
	data-testid="run-outcome-icon"
	data-tone={tone}
>
	<Icon size={14} stroke={1.75} />
</span>
