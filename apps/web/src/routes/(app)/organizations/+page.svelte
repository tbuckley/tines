<script lang="ts">
	import { goto } from '$app/navigation';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import type { OrganizationDetail } from '@tines/shared';
	import Modal from '$lib/components/Modal.svelte';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { packApi } from '$lib/packs-client';

	let { data } = $props();
	let creating = $state(false);
	let name = $state('');
	let busy = $state(false);
	let message = $state<string | null>(null);

	async function create(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		message = null;
		try {
			const org = await packApi<OrganizationDetail>('/api/v1/organizations', 'POST', { name });
			await goto(`/organizations/${org.id}`);
		} catch (e) {
			message = e instanceof Error ? e.message : 'Could not create the organization';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Organizations · Tines</title></svelte:head>

<div class="mx-auto max-w-3xl">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="text-2xl font-semibold">Organizations</h1>
			<p class="text-muted-foreground mt-1 max-w-xl text-sm">
				An organization holds projects. Your personal one is yours alone; everyone in a shared one
				can work in every project in it, while runs stay on each person's own runners.
			</p>
		</div>
		<Button onclick={() => (creating = true)}><IconPlus size={16} /> New organization</Button>
	</div>
	<ul class="mt-6 space-y-3">
		{#each data.organizations as org (org.id)}
			<li>
				<a href={`/organizations/${org.id}`} class="hover:bg-muted/40 block rounded-lg border p-4">
					<div class="flex flex-wrap items-center gap-2">
						<span class="font-medium">{org.name}</span>
						<span class="bg-muted rounded px-1.5 py-0.5 text-xs">{org.kind}</span>
						<span class="text-muted-foreground text-xs">{org.role}</span>
					</div>
					<p class="text-muted-foreground mt-1 text-xs">
						{org.project_count} project{org.project_count === 1 ? '' : 's'} · {org.member_count}
						{org.member_count === 1 ? 'person' : 'people'}
						{#if org.kind === 'shared'}· owned by {org.owner.name}{/if}
					</p>
				</a>
			</li>
		{/each}
	</ul>
</div>

<Modal bind:open={creating} title="New organization">
	<form class="space-y-4" onsubmit={create}>
		<div>
			<label for="org-name" class="text-sm font-medium">Name</label>
			<Input id="org-name" class="mt-1" bind:value={name} required maxlength={100} />
		</div>
		<p class="text-muted-foreground text-sm">
			You will be its owner. Invite people from its page, and move projects into it from each
			project's settings.
		</p>
		{#if message}<p class="text-sm text-red-600" role="alert">{message}</p>{/if}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={() => (creating = false)}>Cancel</Button>
			<PendingButton type="submit" pending={busy}>Create</PendingButton>
		</div>
	</form>
</Modal>
