<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { Button } from '$lib/components/ui/button/index.js';
	import { disclosure } from '$lib/components/disclosure.svelte';

	let {
		future = false,
		role,
		children
	}: {
		future?: boolean;
		/** Owners' agents can run now; members' cannot in this release. */
		role: 'owner' | 'member';
		/** What this particular control does, shown with the notice. */
		children?: Snippet;
	} = $props();

	const acknowledged = $derived(page.data.disclosureAcknowledged || disclosure.acknowledged);
	const subject = $derived(future ? 'Future issues from this schedule' : 'This issue');

	let saving = $state(false);
	let error = $state<string | null>(null);

	async function acknowledge() {
		if (saving) return;
		saving = true;
		error = null;
		try {
			await api.acknowledgePermissionNotice(1);
			disclosure.acknowledged = true;
		} catch {
			error = 'Could not save that. Try again.';
		} finally {
			saving = false;
		}
	}
</script>

{#snippet notice()}
	{#if children}{@render children()}{/if}
	<p class={children ? 'mt-2' : ''}>
		{subject} can change as people add work, comments and artifacts. Permission covers that evolving work
		and uses your own runner and account resources.
		{#if role === 'owner'}
			Your agents may start as soon as it is eligible.
		{:else}
			Your agents may run later when setup is ready, including after member execution is released.
			Member agents cannot run in this release.
		{/if}
		Turning permission off stops new admission but cannot reverse external actions or recall downloaded
		content. Each person controls their own permission.
	</p>
{/snippet}

{#if acknowledged}
	<details class="text-muted-foreground mt-2 text-xs">
		<summary class="cursor-pointer font-medium select-none">What this means</summary>
		<div class="mt-1.5">{@render notice()}</div>
	</details>
{:else}
	<div
		class="mt-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
		role="note"
		aria-label="First permission warning"
	>
		<p class="font-medium">Before you allow your agents</p>
		<div class="mt-1">{@render notice()}</div>
		<div class="mt-2 flex flex-wrap items-center gap-2">
			<Button type="button" size="sm" variant="outline" disabled={saving} onclick={acknowledge}>
				Got it
			</Button>
			{#if error}<span class="text-destructive text-xs" role="alert">{error}</span>{/if}
		</div>
	</div>
{/if}
