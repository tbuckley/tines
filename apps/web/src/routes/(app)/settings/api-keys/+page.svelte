<script lang="ts">
	import type { ApiKeyCreated } from '@tines/shared';
	import { ApiError } from '@tines/shared';
	import IconCheck from '@tabler/icons-svelte/icons/check';
	import IconCopy from '@tabler/icons-svelte/icons/copy';
	import IconKey from '@tabler/icons-svelte/icons/key';
	import { invalidateAll } from '$app/navigation';
	import { api } from '$lib/api';
	import { alertDialog, confirmDialog } from '$lib/components/dialogs.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { formatDateTime, relativeTime } from '$lib/format';

	let { data } = $props();

	let createOpen = $state(false);
	let name = $state('');
	let creating = $state(false);
	let created = $state<ApiKeyCreated | null>(null);
	let copied = $state(false);
	let errorMessage = $state<string | null>(null);

	async function create(e: SubmitEvent) {
		e.preventDefault();
		if (creating) return;
		creating = true;
		errorMessage = null;
		try {
			created = await api.createApiKey({ name });
			name = '';
			await invalidateAll();
		} catch (err) {
			errorMessage = err instanceof ApiError ? err.message : 'Failed to create the key.';
		} finally {
			creating = false;
		}
	}

	async function copyKey() {
		if (!created) return;
		await navigator.clipboard.writeText(created.key);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}

	function closeCreate() {
		createOpen = false;
		created = null;
		copied = false;
		errorMessage = null;
	}

	async function revoke(id: string, keyName: string) {
		const ok = await confirmDialog({
			title: `Revoke API key "${keyName}"?`,
			body: 'Anything using it will immediately lose access.',
			confirmLabel: 'Revoke key',
			destructive: true
		});
		if (!ok) return;
		try {
			await api.revokeApiKey(id);
			await invalidateAll();
		} catch (err) {
			await alertDialog({
				title: 'Revoke failed',
				body: err instanceof ApiError ? err.message : 'Failed to revoke the key.'
			});
		}
	}
</script>

<svelte:head><title>API keys · Tines</title></svelte:head>

<div class="mb-2 flex items-center justify-between">
	<h1 class="text-2xl font-semibold tracking-tight">API keys</h1>
	<Button onclick={() => (createOpen = true)}>
		<IconKey size={16} /> New key
	</Button>
</div>
<p class="text-muted-foreground mb-6 max-w-2xl text-sm">
	Named keys let agents and the CLI act on your behalf — every action they take is attributed to
	the key by name. Pass a key via <code class="bg-muted rounded px-1.5 py-0.5">TINES_API_KEY</code>
	or the <code class="bg-muted rounded px-1.5 py-0.5">Authorization: Bearer</code> header.
</p>

{#if data.keys.length === 0}
	<div class="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
		No API keys yet.
	</div>
{:else}
	<ul class="divide-y rounded-lg border">
		{#each data.keys as key (key.id)}
			<li class="flex items-center gap-4 px-4 py-3 {key.revoked_at ? 'opacity-50' : ''}">
				<div class="min-w-0 flex-1">
					<p class="text-sm font-medium">
						{key.name}
						{#if key.revoked_at}
							<span class="text-destructive ml-2 text-xs font-normal">revoked {relativeTime(key.revoked_at)}</span>
						{/if}
					</p>
					<p class="text-muted-foreground font-mono text-xs">{key.key_prefix}…</p>
				</div>
				<div class="text-muted-foreground hidden text-right text-xs sm:block">
					<p>created {formatDateTime(key.created_at)}</p>
					<p>{key.last_used_at ? `last used ${relativeTime(key.last_used_at)}` : 'never used'}</p>
				</div>
				{#if !key.revoked_at}
					<Button size="sm" variant="outline" onclick={() => revoke(key.id, key.name)}>Revoke</Button>
				{/if}
			</li>
		{/each}
	</ul>
{/if}

<Modal bind:open={createOpen} title={created ? 'API key created' : 'New API key'} onclose={closeCreate}>
	{#if created}
		<div class="space-y-4">
			<p class="text-sm">
				Copy the key for <span class="font-medium">{created.name}</span> now —
				<span class="font-medium">it will not be shown again.</span>
			</p>
			<div class="flex items-center gap-2">
				<code class="bg-muted min-w-0 flex-1 overflow-x-auto rounded-md px-3 py-2 font-mono text-xs">
					{created.key}
				</code>
				<Button size="sm" variant="outline" onclick={copyKey}>
					{#if copied}<IconCheck size={14} /> Copied{:else}<IconCopy size={14} /> Copy{/if}
				</Button>
			</div>
			<p class="text-muted-foreground text-xs">
				e.g. <code class="bg-muted rounded px-1 py-0.5">TINES_API_KEY={created.key.slice(0, 14)}… tines issues list</code>
			</p>
			<div class="flex justify-end">
				<Button onclick={closeCreate}>Done</Button>
			</div>
		</div>
	{:else}
		<form onsubmit={create} class="space-y-4">
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="key-name">Name</label>
				<Input id="key-name" bind:value={name} placeholder="e.g. laptop-claude" required />
				<p class="text-muted-foreground text-xs">
					Name it after the agent or machine that will use it — actions show up as “via this key”.
				</p>
			</div>
			{#if errorMessage}
				<p class="text-destructive text-sm">{errorMessage}</p>
			{/if}
			<div class="flex justify-end gap-2">
				<Button type="button" variant="ghost" onclick={closeCreate}>Cancel</Button>
				<Button type="submit" disabled={creating || !name.trim()}>
					{creating ? 'Creating…' : 'Create key'}
				</Button>
			</div>
		</form>
	{/if}
</Modal>
