<script lang="ts">
	import type { FocusNotice } from '$lib/focus-types';
	import { truncate } from '$lib/format';

	let { notice, scopeLabel }: { notice: FocusNotice | null; scopeLabel: string } = $props();
</script>

{#if notice}
	<p
		class="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-300"
		role="status"
	>
		{#if notice.kind === 'unknown'}
			No project “{truncate(notice.ref, 40)}”. Showing {scopeLabel}.
		{:else}
			Project “{truncate(notice.project.name, 40)}” is archived. Showing {scopeLabel}.
			<a class="underline underline-offset-2" href="/projects/{notice.project.id}">View project</a>
		{/if}
	</p>
{/if}
