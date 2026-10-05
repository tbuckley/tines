<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import type { OrganizationSummary, ProjectMovePreview } from '@tines/shared';
	import Modal from '$lib/components/Modal.svelte';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { packApi } from '$lib/packs-client';

	let {
		open = $bindable(false),
		mode,
		project,
		organizations
	}: {
		open?: boolean;
		/** `share`: a new shared organization for this personal project; `move`: another organization. */
		mode: 'move' | 'share';
		project: { id: string; name: string; organization?: { id: string; name: string } };
		organizations: OrganizationSummary[];
	} = $props();

	const targets = $derived(
		organizations.filter((o) => o.id !== project.organization?.id && o.role !== 'member')
	);
	let to = $state('');
	let preview = $state<ProjectMovePreview | null>(null);
	let shareName = $state('');
	let bringContext = $state(true);
	let busy = $state(false);
	let message = $state<string | null>(null);

	$effect(() => {
		if (open && mode === 'share' && !shareName) shareName = project.name;
	});

	async function load() {
		preview = null;
		message = null;
		if (!to) return;
		busy = true;
		try {
			preview = await packApi<ProjectMovePreview>(
				`/api/v1/projects/${project.id}/move?to=${encodeURIComponent(to)}`
			);
		} catch (e) {
			message = e instanceof Error ? e.message : 'Could not preview the move';
		} finally {
			busy = false;
		}
	}

	async function confirm() {
		busy = true;
		message = null;
		try {
			if (mode === 'share')
				await packApi(`/api/v1/projects/${project.id}/share`, 'POST', {
					name: shareName,
					bring_context: bringContext
				});
			else if (preview)
				await packApi(`/api/v1/projects/${project.id}/move`, 'POST', {
					to_organization_id: preview.to.id,
					expected_digest: preview.digest
				});
			open = false;
			await invalidateAll();
			await goto(`/projects/${project.id}`, { invalidateAll: true });
		} catch (e) {
			message = e instanceof Error ? e.message : 'The move failed';
		} finally {
			busy = false;
		}
	}
</script>

<Modal
	bind:open
	title={mode === 'share' ? `Share ${project.name}` : `Move ${project.name}`}
	size="xl"
>
	{#if mode === 'share'}
		<div class="space-y-4 text-sm">
			<p>
				Sharing creates a shared organization and moves this project into it. You stay its owner and
				invite people from the organization's page; everyone in it works in every project in it.
			</p>
			<div>
				<label for="share-name" class="font-medium">Organization name</label>
				<Input id="share-name" class="mt-1" bind:value={shareName} />
			</div>
			<label class="flex items-start gap-2">
				<input type="checkbox" class="mt-1" bind:checked={bringContext} />
				<span>
					Bring the context that applies to this project — copies your global prompts, skills, env
					and repos into the new organization. Without it, only the workflows' own state context
					comes along.
				</span>
			</label>
			<p class="text-muted-foreground">
				The workflows this project uses come along as copies. Your API keys that reach this project
				gain the new organization.
			</p>
		</div>
	{:else}
		<div class="space-y-4 text-sm">
			<div>
				<label for="move-to" class="font-medium">Move to</label>
				<select
					id="move-to"
					class="border-input dark:bg-input/30 mt-1 h-9 w-full rounded-md border bg-transparent px-3 text-sm"
					bind:value={to}
					onchange={load}
				>
					<option value="">Choose an organization…</option>
					{#each targets as o (o.id)}<option value={o.id}>{o.name} ({o.kind})</option>{/each}
				</select>
			</div>
			{#if preview}
				{#if preview.blockers.length}
					<div class="rounded-md border border-red-500/40 bg-red-500/5 p-3">
						<p class="font-medium">This cannot move yet</p>
						<ul class="mt-1 list-disc pl-5">
							{#each preview.blockers as b (b.message)}<li>{b.message}</li>{/each}
						</ul>
					</div>
				{/if}
				<div>
					<h3 class="font-medium">People</h3>
					<p>
						{#if preview.people.gain.length}Gain access: {preview.people.gain
								.map((p) => p.name)
								.join(', ')}.{/if}
						{#if preview.people.lose.length}
							Lose access (their permissions and runs here end): {preview.people.lose
								.map((p) => p.name)
								.join(', ')}.
						{/if}
						{#if !preview.people.gain.length && !preview.people.lose.length}No one gains or loses
							access.{/if}
					</p>
				</div>
				<div>
					<h3 class="font-medium">Workflows</h3>
					<ul class="mt-1 space-y-0.5">
						{#each preview.workflows as w (w.id)}
							<li>
								{w.name} —
								{w.handling === 'copy'
									? 'a copy comes along (issues and schedules move to it)'
									: w.handling === 'system'
										? 'built in, stays'
										: 'moves with the project'}
								<span class="text-muted-foreground"
									>({w.issues} issues, {w.schedules} schedules)</span
								>
							</li>
						{/each}
					</ul>
				</div>
				{#if preview.labels.length}
					<div>
						<h3 class="font-medium">Labels</h3>
						<p>
							{preview.labels
								.map((l) => `${l.name} (${l.handling === 'copy' ? 'copied' : 'uses theirs'})`)
								.join(', ')}
						</p>
					</div>
				{/if}
				{#if preview.context_lost.length}
					<div>
						<h3 class="font-medium">Context this project stops reading</h3>
						<p class="text-muted-foreground">
							{preview.context_lost.map((c) => `${c.kind} ${c.name}`).join(', ')}
						</p>
					</div>
				{/if}
			{/if}
		</div>
	{/if}
	{#if message}<p class="mt-3 text-sm text-red-600" role="alert">{message}</p>{/if}
	<div class="mt-5 flex justify-end gap-2">
		<Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
		<PendingButton
			pending={busy}
			disabled={mode === 'move' && (!preview || preview.blockers.length > 0)}
			onclick={confirm}>{mode === 'share' ? 'Share' : 'Move project'}</PendingButton
		>
	</div>
</Modal>
