<script lang="ts">
	import { goto } from '$app/navigation';
	import IconChevronLeft from '@tabler/icons-svelte/icons/chevron-left';
	import IconPackage from '@tabler/icons-svelte/icons/package';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import IconUpload from '@tabler/icons-svelte/icons/upload';
	import type { PackDetail } from '@tines/shared';
	import Modal from '$lib/components/Modal.svelte';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { packApi } from '$lib/packs-client';

	let { data } = $props();
	let creating = $state(false);
	let name = $state('');
	let description = $state('');
	let busy = $state(false);
	let message = $state<string | null>(null);

	async function create(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		message = null;
		try {
			const pack = await packApi<PackDetail>(`/api/v1/projects/${data.project.id}/packs`, 'POST', {
				name,
				description
			});
			await goto(`/projects/${data.project.id}/packs/${pack.id}`);
		} catch (e) {
			message = e instanceof Error ? e.message : 'Could not create the pack';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Packs · {data.project.name} · Tines</title></svelte:head>

<div class="mx-auto max-w-3xl">
	<a
		class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
		href={`/projects/${data.project.id}`}><IconChevronLeft size={16} />{data.project.name}</a
	>
	<div class="mt-5 flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="text-2xl font-semibold">Packs</h1>
			<p class="text-muted-foreground mt-1 max-w-xl text-sm">
				Workflows and the context that goes with them, shared as one unit. Later packs in the list
				win a name over earlier ones; the project's own items win over every pack's.
			</p>
		</div>
		{#if !data.project.archived}
			<div class="flex gap-2">
				<Button variant="outline" onclick={() => (creating = true)}>
					<IconPlus size={16} /> New pack
				</Button>
				<Button href={`/projects/${data.project.id}/packs/install`}>
					<IconUpload size={16} /> Install
				</Button>
			</div>
		{/if}
	</div>

	{#if data.packs.length === 0}
		<div class="mt-8 rounded-lg border border-dashed p-8 text-center">
			<IconPackage size={28} class="text-muted-foreground mx-auto" aria-hidden="true" />
			<p class="mt-2 font-medium">No packs yet</p>
			<p class="text-muted-foreground mt-1 text-sm">
				Install a <code>.tinespack</code>, one from another of your projects, or start a new pack
				here.
			</p>
		</div>
	{:else}
		<ol class="mt-6 space-y-3">
			{#each data.packs as pack (pack.id)}
				<li>
					<a
						href={`/projects/${data.project.id}/packs/${pack.id}`}
						class="hover:bg-muted/40 block rounded-lg border p-4"
					>
						<div class="flex flex-wrap items-center gap-2">
							<span class="font-medium">{pack.name}</span>
							<span class="bg-muted rounded px-1.5 py-0.5 text-xs">{pack.kind}</span>
							{#if pack.version !== null}<span class="text-muted-foreground text-xs"
									>v{pack.version}</span
								>{/if}
							{#if pack.needs_setup.length}
								<span
									class="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-800 dark:text-amber-300"
									>needs setup</span
								>
							{/if}
							{#if pack.newer_version_available}
								<span
									class="rounded bg-sky-500/15 px-1.5 py-0.5 text-xs text-sky-800 dark:text-sky-300"
									>newer version available</span
								>
							{/if}
							{#if pack.kind === 'authored' && pack.changed_since_export}
								<span class="text-muted-foreground text-xs">changed since export</span>
							{/if}
						</div>
						{#if pack.description}<p class="text-muted-foreground mt-1 text-sm">
								{pack.description}
							</p>{/if}
						<p class="text-muted-foreground mt-2 text-xs">
							<code>{pack.pack_key}</code>
							· {pack.workflow_count} workflow{pack.workflow_count === 1 ? '' : 's'} · {pack.item_count}
							context item{pack.item_count === 1 ? '' : 's'}
							{#if pack.source?.kind === 'project'}
								· from {pack.source.project_name ?? 'a removed pack'}
							{:else if pack.source?.kind === 'file'}
								· from a file
							{/if}
						</p>
					</a>
				</li>
			{/each}
		</ol>
	{/if}
</div>

<Modal bind:open={creating} title="New pack">
	<form class="space-y-4" onsubmit={create}>
		<div>
			<label for="pack-name" class="text-sm font-medium">Name</label>
			<Input id="pack-name" class="mt-1" bind:value={name} required maxlength={100} />
		</div>
		<div>
			<label for="pack-description" class="text-sm font-medium">Description</label>
			<Textarea id="pack-description" class="mt-1" bind:value={description} rows={3} />
		</div>
		{#if message}<p class="text-sm text-red-600" role="alert">{message}</p>{/if}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="outline" onclick={() => (creating = false)}>Cancel</Button>
			<PendingButton type="submit" pending={busy}>Create pack</PendingButton>
		</div>
	</form>
</Modal>
