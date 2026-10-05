<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import IconChevronLeft from '@tabler/icons-svelte/icons/chevron-left';
	import Modal from '$lib/components/Modal.svelte';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { packApi } from '$lib/packs-client';

	let { data } = $props();
	const org = $derived(data.organization);
	const base = $derived(`/api/v1/organizations/${org.id}`);
	const canManage = $derived(org.kind === 'shared' && org.role !== 'member');
	const isOwner = $derived(org.role === 'owner');

	let busy = $state<string | null>(null);
	let message = $state<string | null>(null);
	let notice = $state<string | null>(null);
	async function act<T>(key: string, fn: () => Promise<T>, done?: string): Promise<T | null> {
		busy = key;
		message = null;
		notice = null;
		try {
			const out = await fn();
			await invalidateAll();
			if (done) notice = done;
			return out;
		} catch (e) {
			message = e instanceof Error ? e.message : 'Request failed';
			return null;
		} finally {
			busy = null;
		}
	}

	let email = $state('');
	async function invite(event: SubmitEvent) {
		event.preventDefault();
		const to = email;
		const out = await act('invite', () =>
			packApi<{ delivery_status: string }>(`${base}/invitations`, 'POST', { email: to })
		);
		if (out) {
			email = '';
			notice =
				out.delivery_status === 'sent'
					? 'Invitation sent.'
					: 'Invitation saved, but the email could not be sent.';
		}
	}

	let renaming = $state(false);
	let newName = $state('');
	let transferTo = $state('');
	let deleting = $state(false);
	let confirmName = $state('');

	async function leave() {
		if (!confirm(`Leave ${org.name}? You lose access to its projects.`)) return;
		const ok = await act('leave', () => packApi(`${base}/leave`, 'POST', {}));
		if (ok) await goto('/organizations');
	}
	async function remove(userId: string, name: string) {
		if (!confirm(`Remove ${name} from ${org.name}? They lose access to its projects.`)) return;
		await act(`remove-${userId}`, () => packApi(`${base}/members/${userId}`, 'DELETE'));
	}
	async function transfer() {
		const to = transferTo;
		const person = org.members.find((m) => m.user_id === to);
		if (!person || !confirm(`Make ${person.name} the owner of ${org.name}? You become a manager.`))
			return;
		await act(
			'transfer',
			() =>
				packApi(`${base}/transfer`, 'POST', { to_user_id: to, expected_revision: org.revision }),
			'Ownership transferred.'
		);
	}
	async function destroy() {
		const name = confirmName;
		const ok = await act('delete', () => packApi(base, 'DELETE', { confirm_name: name }));
		if (ok) await goto('/organizations');
	}
</script>

<svelte:head><title>{org.name} · Organizations · Tines</title></svelte:head>

<div class="mx-auto max-w-3xl pb-16">
	<a
		class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
		href="/organizations"><IconChevronLeft size={16} />Organizations</a
	>
	<div class="mt-5 flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="text-2xl font-semibold">{org.name}</h1>
			<p class="text-muted-foreground mt-1 text-sm">
				{org.kind === 'personal'
					? 'Your personal organization'
					: `Shared · you are ${org.role === 'owner' ? 'the owner' : `a ${org.role}`}`}
			</p>
		</div>
		<div class="flex flex-wrap gap-2">
			{#if isOwner && org.kind === 'shared'}
				<Button
					variant="outline"
					onclick={() => {
						newName = org.name;
						renaming = true;
					}}>Rename</Button
				>
			{/if}
			{#if org.kind === 'shared' && !isOwner}
				<PendingButton variant="outline" pending={busy === 'leave'} onclick={leave}
					>Leave</PendingButton
				>
			{/if}
		</div>
	</div>
	{#if message}<p class="mt-4 text-sm text-red-600" role="alert">{message}</p>{/if}
	{#if notice}<p class="mt-4 text-sm" role="status">{notice}</p>{/if}

	<section class="mt-6 rounded-lg border p-4" aria-labelledby="projects-heading">
		<h2 id="projects-heading" class="font-semibold">Projects</h2>
		{#if org.projects.length === 0}
			<p class="text-muted-foreground mt-2 text-sm">
				No projects yet. Create one here from the Projects page, or move one in from its settings.
			</p>
		{:else}
			<ul class="mt-2 space-y-1 text-sm">
				{#each org.projects as p (p.id)}
					<li>
						<a class="underline-offset-4 hover:underline" href={`/projects/${p.id}`}>{p.name}</a>
						<span class="text-muted-foreground"
							>— {p.issue_count} issue{p.issue_count === 1 ? '' : 's'}{p.archived_at
								? ' · archived'
								: ''}</span
						>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="mt-4 rounded-lg border p-4" aria-labelledby="people-heading">
		<h2 id="people-heading" class="font-semibold">People</h2>
		<ul class="mt-2 space-y-2">
			{#each org.members as m (m.user_id)}
				<li class="flex flex-wrap items-center justify-between gap-2 text-sm">
					<span>
						{m.name}
						<span class="text-muted-foreground"
							>{m.email ? `· ${m.email} ` : ''}· {m.role}{m.user_id === data.viewerId
								? ' · you'
								: ''}</span
						>
					</span>
					{#if canManage && m.role !== 'owner' && m.user_id !== data.viewerId}
						<PendingButton
							size="sm"
							variant="outline"
							pending={busy === `remove-${m.user_id}`}
							onclick={() => remove(m.user_id, m.name)}>Remove</PendingButton
						>
					{/if}
				</li>
			{/each}
		</ul>
		{#if canManage}
			<form class="mt-4 flex flex-wrap items-end gap-2 border-t pt-4" onsubmit={invite}>
				<div class="min-w-0 flex-1">
					<label for="invite-email" class="text-sm font-medium">Invite someone</label>
					<Input id="invite-email" type="email" class="mt-1" bind:value={email} required />
				</div>
				<PendingButton type="submit" pending={busy === 'invite'}>Invite</PendingButton>
			</form>
			<p class="text-muted-foreground mt-1 text-xs">
				People join as managers: they can work in every project here and invite others. Their agents
				do not run here yet.
			</p>
			{#if org.invitations.length}
				<h3 class="mt-4 text-sm font-medium">Pending invitations</h3>
				<ul class="mt-1 space-y-1 text-sm">
					{#each org.invitations as inv (inv.id)}
						<li class="flex items-center justify-between gap-2">
							<span
								>{inv.email}
								<span class="text-muted-foreground text-xs">· {inv.delivery_status}</span></span
							>
							<Button
								size="sm"
								variant="outline"
								onclick={() =>
									act('cancel', () => packApi(`${base}/invitations/${inv.id}`, 'DELETE'))}
								>Cancel</Button
							>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</section>

	{#if isOwner && org.kind === 'shared'}
		<section class="mt-4 rounded-lg border p-4" aria-labelledby="owner-heading">
			<h2 id="owner-heading" class="font-semibold">Ownership</h2>
			{#if org.members.some((m) => m.role !== 'owner')}
				<div class="mt-2 flex flex-wrap items-end gap-2">
					<div class="min-w-0 flex-1">
						<label for="transfer-to" class="text-sm font-medium">Transfer to</label>
						<select
							id="transfer-to"
							class="border-input dark:bg-input/30 mt-1 h-9 w-full rounded-md border bg-transparent px-3 text-sm"
							bind:value={transferTo}
						>
							<option value="">Choose a manager…</option>
							{#each org.members.filter((m) => m.role !== 'owner') as m (m.user_id)}
								<option value={m.user_id}>{m.name}</option>
							{/each}
						</select>
					</div>
					<PendingButton pending={busy === 'transfer'} disabled={!transferTo} onclick={transfer}
						>Transfer</PendingButton
					>
				</div>
				<p class="text-muted-foreground mt-1 text-xs">
					The new owner's runners then run this organization's issues, and its projects, workflows,
					labels and context become theirs.
				</p>
			{/if}
			<div class="mt-4 border-t pt-4">
				<Button variant="destructive" onclick={() => (deleting = true)}>Delete organization</Button>
			</div>
		</section>
	{/if}
</div>

<Modal bind:open={renaming} title="Rename organization">
	<div class="space-y-4">
		<Input aria-label="Name" bind:value={newName} />
		<div class="flex justify-end gap-2">
			<Button variant="outline" onclick={() => (renaming = false)}>Cancel</Button>
			<PendingButton
				pending={busy === 'rename'}
				onclick={async () => {
					const name = newName;
					const ok = await act('rename', () =>
						packApi(base, 'PATCH', { name, expected_revision: org.revision })
					);
					if (ok) renaming = false;
				}}>Save</PendingButton
			>
		</div>
	</div>
</Modal>

<Modal bind:open={deleting} title="Delete {org.name}?">
	<div class="space-y-3 text-sm">
		<p>
			This deletes the organization, its empty projects, and its workflows, labels and context.
			Projects with issues must be moved out first:
		</p>
		<ul class="list-disc pl-5">
			{#each org.projects as p (p.id)}
				<li>
					{p.name} — {p.issue_count} issue{p.issue_count === 1 ? '' : 's'}
					{#if p.issue_count > 0}<a class="underline" href={`/projects/${p.id}`}
							>move it out first</a
						>{/if}
				</li>
			{/each}
		</ul>
		<label for="confirm-org" class="block font-medium">Type “{org.name}” to confirm</label>
		<Input id="confirm-org" bind:value={confirmName} />
		<div class="flex justify-end gap-2">
			<Button variant="outline" onclick={() => (deleting = false)}>Cancel</Button>
			<PendingButton
				variant="destructive"
				pending={busy === 'delete'}
				disabled={confirmName !== org.name}
				onclick={destroy}>Delete</PendingButton
			>
		</div>
	</div>
</Modal>
