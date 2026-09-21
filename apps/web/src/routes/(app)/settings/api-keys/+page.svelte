<script lang="ts">
	import type { ApiKey, ApiKeyCreated, ApiKeyPermissions } from '@tines/shared';
	import {
		ApiError,
		FULL_API_KEY_PERMISSIONS,
		PROJECT_AUTOMATION_API_KEY_PERMISSIONS,
		READ_ONLY_API_KEY_PERMISSIONS,
		RUNNER_SETUP_API_KEY_PERMISSIONS,
		parseApiKeyPermissions,
		runRefLabel
	} from '@tines/shared';
	import IconCheck from '@tabler/icons-svelte/icons/check';
	import IconCopy from '@tabler/icons-svelte/icons/copy';
	import IconKey from '@tabler/icons-svelte/icons/key';
	import { untrack } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { alertDialog, confirmDialog } from '$lib/components/dialogs.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { formatDateTime, relativeTime } from '$lib/format';

	let { data } = $props();

	// Run keys are minted one per agent run and outnumber the user's own keys
	// by orders of magnitude, so they live behind a disclosure rather than in
	// the list the user manages.
	const userKeys = $derived(data.keys.filter((k) => !k.run));
	const runKeys = $derived(data.keys.filter((k) => k.run));
	const hasRunKeys = $derived(data.runKeyCounts.active + data.runKeyCounts.revoked > 0);
	// Bound, not a plain `open` attribute: "Show revoked" lives *inside* the
	// disclosure and navigates, so the open state has to outlive the loader
	// re-run rather than be re-derived from it (untrack: ?revoked=1 seeds the
	// initial value, it does not drive it thereafter).
	let runKeysOpen = $state(untrack(() => data.showRevoked));

	function setRevoked(on: boolean) {
		const params = new URLSearchParams(page.url.searchParams);
		if (on) params.set('revoked', '1');
		else params.delete('revoked');
		goto(`/settings/api-keys${params.size ? `?${params}` : ''}`, {
			keepFocus: true,
			noScroll: true,
			replaceState: true
		});
	}

	let createOpen = $state(false);
	let name = $state('');
	let preset = $state<'full' | 'read-only' | 'project-automation' | 'runner-setup'>('full');
	let selectedProjectIds = $state<string[]>([]);
	let allProjects = $state(false);
	let creating = $state(false);
	let created = $state<ApiKeyCreated | null>(null);
	let copied = $state(false);
	let errorMessage = $state<string | null>(null);
	const availableProjects = $derived([...data.projects, ...data.archivedProjects]);

	function permissionsForCreate(): ApiKeyPermissions {
		const base =
			preset === 'read-only'
				? READ_ONLY_API_KEY_PERMISSIONS
				: preset === 'project-automation'
					? PROJECT_AUTOMATION_API_KEY_PERMISSIONS
					: preset === 'runner-setup'
						? RUNNER_SETUP_API_KEY_PERMISSIONS
						: FULL_API_KEY_PERMISSIONS;
		const permissions = parseApiKeyPermissions(JSON.parse(JSON.stringify(base)));
		if (preset === 'project-automation') {
			permissions.projects.scope = allProjects ? 'all' : [...selectedProjectIds];
		}
		return permissions;
	}

	function permissionSummary(permissions: ApiKeyPermissions): string {
		const scope =
			permissions.projects.scope === 'all'
				? 'all projects'
				: permissions.projects.scope.length === 0
					? 'no projects'
					: `${permissions.projects.scope.length} selected project${permissions.projects.scope.length === 1 ? '' : 's'}`;
		return `Projects ${permissions.projects.access} (${scope}) · Workspace ${permissions.workspace} · Control plane ${permissions.control_plane}`;
	}

	async function create(e: SubmitEvent) {
		e.preventDefault();
		if (creating) return;
		creating = true;
		errorMessage = null;
		try {
			created = await api.createApiKey({ name, permissions: permissionsForCreate() });
			name = '';
			preset = 'full';
			selectedProjectIds = [];
			allProjects = false;
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

	/**
	 * A run key belongs to an agent that may still be working: name the run it
	 * would cut off, and point at the clean way to stop it.
	 */
	async function revokeRunKey(key: ApiKey) {
		if (!key.run) return;
		const ref = key.run.issue_ref
			? `${key.run.issue_ref.project_name}/${key.run.issue_ref.number}`
			: key.run.run_id;
		const ok = await confirmDialog({
			title: `Revoke the run key for ${ref}?`,
			body:
				`This key belongs to the agent run on ${ref} (runner ${key.run.runner_name}). ` +
				'Revoking it cuts the agent off mid-run; the run keeps its slot until it fails or is ' +
				'swept. To stop the run cleanly, cancel it from the Agents page instead.',
			confirmLabel: 'Revoke key',
			destructive: true
		});
		if (!ok) return;
		await revokeById(key.id);
	}

	async function revokeById(id: string) {
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

	async function revoke(id: string, keyName: string) {
		const ok = await confirmDialog({
			title: `Revoke API key "${keyName}"?`,
			body: 'Anything using it will immediately lose access.',
			confirmLabel: 'Revoke key',
			destructive: true
		});
		if (!ok) return;
		await revokeById(id);
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
	Named keys let agents and the CLI act on your behalf — every action they take is attributed to the
	key by name. Pass a key via <code class="bg-muted rounded px-1.5 py-0.5">TINES_API_KEY</code>
	or the <code class="bg-muted rounded px-1.5 py-0.5">Authorization: Bearer</code> header.
</p>

{#if userKeys.length === 0}
	<div class="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
		No API keys yet.
	</div>
{:else}
	<ul class="divide-y rounded-lg border">
		{#each userKeys as key (key.id)}
			<li class="flex items-center gap-4 px-4 py-3 {key.revoked_at ? 'opacity-50' : ''}">
				<div class="min-w-0 flex-1">
					<p class="text-sm font-medium">
						{key.name}
						{#if key.revoked_at}
							<span class="text-destructive ml-2 text-xs font-normal"
								>revoked {relativeTime(key.revoked_at)}</span
							>
						{/if}
					</p>
					<p class="text-muted-foreground font-mono text-xs">{key.key_prefix}…</p>
					<p class="text-muted-foreground mt-1 text-xs">
						{permissionSummary(key.permissions)}
					</p>
				</div>
				<div class="text-muted-foreground hidden text-right text-xs sm:block">
					<p>created {formatDateTime(key.created_at)}</p>
					<p>{key.last_used_at ? `last used ${relativeTime(key.last_used_at)}` : 'never used'}</p>
				</div>
				{#if !key.revoked_at}
					<Button size="sm" variant="outline" onclick={() => revoke(key.id, key.name)}
						>Revoke</Button
					>
				{/if}
			</li>
		{/each}
	</ul>
{/if}

{#if hasRunKeys}
	<details class="group mt-6 border-t pt-3" bind:open={runKeysOpen} data-testid="run-keys">
		<summary class="text-muted-foreground hover:text-foreground cursor-pointer text-sm select-none">
			Run keys
			<span class="text-xs"
				>— {data.runKeyCounts.active} active, {data.runKeyCounts.revoked} revoked</span
			>
		</summary>
		<p class="text-muted-foreground mt-2 max-w-2xl text-xs">
			Minted for each agent run and revoked when the run ends. Actions taken with one are attributed
			to the runner and its run.
		</p>
		<label class="text-muted-foreground mt-3 flex items-center gap-2 text-xs">
			<input
				type="checkbox"
				checked={data.showRevoked}
				class="accent-primary"
				onchange={(e) => setRevoked(e.currentTarget.checked)}
			/>
			Show revoked
		</label>
		{#if runKeys.length === 0}
			<div
				class="text-muted-foreground mt-3 rounded-lg border border-dashed p-6 text-center text-sm"
			>
				{data.showRevoked ? 'No run keys.' : 'No active run keys.'}
			</div>
		{:else}
			<ul class="mt-3 divide-y rounded-lg border">
				{#each runKeys as key (key.id)}
					<li class="flex items-center gap-4 px-4 py-3 {key.revoked_at ? 'opacity-50' : ''}">
						<div class="min-w-0 flex-1">
							<p class="text-sm font-medium" title="run {key.run?.run_id} · {key.run?.runner_name}">
								{#if key.run?.issue_ref}
									<a
										href="/issues/{key.run.issue_ref.project_name}/{key.run.issue_ref.number}"
										class="hover:underline">{runRefLabel(key.run)}</a
									>
								{:else if key.run}
									{runRefLabel(key.run)}
								{/if}
								{#if key.revoked_at}
									<span class="text-destructive ml-2 text-xs font-normal"
										>revoked {relativeTime(key.revoked_at)}</span
									>
								{/if}
							</p>
							<p class="text-muted-foreground truncate font-mono text-xs">
								{key.run?.runner_name} · {key.key_prefix}…
							</p>
						</div>
						<div class="text-muted-foreground hidden text-right text-xs sm:block">
							<p>created {formatDateTime(key.created_at)}</p>
							<p>
								{key.last_used_at ? `last used ${relativeTime(key.last_used_at)}` : 'never used'}
							</p>
						</div>
						{#if !key.revoked_at}
							<Button size="sm" variant="outline" onclick={() => revokeRunKey(key)}>Revoke</Button>
						{/if}
					</li>
				{/each}
			</ul>
			{#if data.showRevoked && data.runKeyCounts.revoked > data.revokedRunKeyLimit}
				<p class="text-muted-foreground mt-2 text-xs">
					Showing the {data.revokedRunKeyLimit} most recently revoked of {data.runKeyCounts
						.revoked}. Older runs are in the
					<a href="/activity" class="hover:underline">Activity</a> feed.
				</p>
			{/if}
		{/if}
	</details>
{/if}

<Modal
	bind:open={createOpen}
	title={created ? 'API key created' : 'New API key'}
	onclose={closeCreate}
>
	{#if created}
		<div class="space-y-4">
			<p class="text-sm">
				Copy the key for <span class="font-medium">{created.name}</span> now —
				<span class="font-medium">it will not be shown again.</span>
			</p>
			<p class="text-muted-foreground text-xs">{permissionSummary(created.permissions)}</p>
			<div class="flex items-center gap-2">
				<code
					class="bg-muted min-w-0 flex-1 overflow-x-auto rounded-md px-3 py-2 font-mono text-xs"
				>
					{created.key}
				</code>
				<Button size="sm" variant="outline" onclick={copyKey}>
					{#if copied}<IconCheck size={14} /> Copied{:else}<IconCopy size={14} /> Copy{/if}
				</Button>
			</div>
			<p class="text-muted-foreground text-xs">
				e.g. <code class="bg-muted rounded px-1 py-0.5"
					>TINES_API_KEY={created.key.slice(0, 14)}… tines issues list</code
				>
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
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="key-preset">Permissions</label>
				<select
					id="key-preset"
					bind:value={preset}
					class="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
				>
					<option value="full">Full authority</option>
					<option value="read-only">Read only</option>
					<option value="project-automation">Project automation</option>
					<option value="runner-setup">Runner setup</option>
				</select>
				<p class="text-muted-foreground text-xs">
					{permissionSummary(permissionsForCreate())}
				</p>
			</div>
			{#if preset === 'project-automation'}
				<fieldset class="space-y-2 rounded-md border p-3">
					<legend class="px-1 text-sm font-medium">Project scope</legend>
					<label class="flex items-center gap-2 text-sm">
						<input type="checkbox" bind:checked={allProjects} class="accent-primary" />
						All projects
					</label>
					{#if !allProjects}
						{#each availableProjects as project (project.id)}
							<label class="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									value={project.id}
									bind:group={selectedProjectIds}
									class="accent-primary"
								/>
								{project.name}{project.archived_at ? ' (archived)' : ''}
							</label>
						{/each}
					{/if}
				</fieldset>
			{/if}
			{#if errorMessage}
				<p class="text-destructive text-sm">{errorMessage}</p>
			{/if}
			<div class="flex flex-wrap justify-end gap-2">
				<Button type="button" variant="ghost" disabled={creating} onclick={closeCreate}
					>Cancel</Button
				>
				<PendingButton
					type="submit"
					pending={creating}
					pendingLabel="Creating…"
					disabled={!name.trim() ||
						(preset === 'project-automation' && !allProjects && selectedProjectIds.length === 0)}
				>
					Create key
				</PendingButton>
			</div>
		</form>
	{/if}
</Modal>
