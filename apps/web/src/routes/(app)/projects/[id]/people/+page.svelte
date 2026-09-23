<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	let { data } = $props();
	let email = $state('');
	let issueId = $state('');
	let confirmSharing = $state(false);
	let busy = $state(false);
	let message = $state<string | null>(null);
	async function request(path: string, method: string, body: object) {
		busy = true;
		message = null;
		try {
			const response = await fetch(path, {
				method,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			const value = response.status === 204 ? null : await response.json();
			if (!response.ok) throw new Error(value?.error?.message ?? 'Request failed');
			await invalidateAll();
			return value;
		} catch (error) {
			message = error instanceof Error ? error.message : 'Request failed';
			return null;
		} finally {
			busy = false;
		}
	}
	async function invite(event: SubmitEvent) {
		event.preventDefault();
		const result = await request(`/api/v1/projects/${data.projectId}/invitations`, 'POST', {
			email,
			...(issueId.trim() ? { landing_issue_id: issueId.trim() } : {}),
			confirm_sharing: confirmSharing,
			expected_sharing_revision: data.project.sharing_revision
		});
		if (result) {
			email = '';
			issueId = '';
			message =
				result.delivery_status === 'sent'
					? 'Invitation sent.'
					: 'Invitation saved, but email delivery failed. Resend to try again.';
		}
	}
	async function leave() {
		const result = await request(`/api/v1/projects/${data.projectId}/leave`, 'POST', {
			expected_revision: data.membershipRevision
		});
		if (result) await goto('/projects');
	}
</script>

<main class="mx-auto max-w-3xl px-4 py-6">
	<a class="underline" href={`/projects/${data.projectId}`}>← {data.project.name}</a>
	<h1 class="mt-5 text-2xl font-semibold">People</h1>
	<p class="text-muted-foreground mt-2">
		Members can read the project. Their agents cannot run here in this release.
	</p>
	{#if message}<p class="mt-4" role="status">{message}</p>{/if}
	<section class="mt-6 rounded-lg border p-4" aria-labelledby="roster-heading">
		<h2 id="roster-heading" class="font-semibold">Project members</h2>
		<ul class="mt-3 space-y-3">
			<li>
				{data.people.owner.name}
				<span class="text-muted-foreground"
					>Owner{data.people.owner.id === data.viewerId ? ' · You' : ''}</span
				>
			</li>
			{#each data.people.members as member (member.id)}
				<li class="flex flex-wrap items-center justify-between gap-2">
					<span>{member.name}{member.id === data.viewerId ? ' · You' : ''}</span>
					{#if data.role === 'owner'}<button
							class="rounded border px-3 py-2"
							disabled={busy}
							onclick={() =>
								request(`/api/v1/projects/${data.projectId}/members/${member.id}`, 'DELETE', {
									expected_revision: member.revision
								})}>Remove</button
						>{/if}
				</li>
			{/each}
		</ul>
		{#if data.role === 'member'}<button
				class="mt-5 rounded border px-4 py-3"
				disabled={busy}
				onclick={leave}>Leave project</button
			>{/if}
	</section>
	{#if data.role === 'owner'}
		<section class="mt-6 rounded-lg border p-4" aria-labelledby="invite-heading">
			<h2 id="invite-heading" class="font-semibold">Invite someone</h2>
			<form class="mt-3 space-y-3" onsubmit={invite}>
				<label class="block"
					>Verified email<input
						class="mt-1 w-full rounded border p-3"
						type="email"
						bind:value={email}
						required
					/></label
				>
				<label class="block"
					>Landing issue ID (optional)<input
						class="mt-1 w-full rounded border p-3"
						bind:value={issueId}
					/></label
				>
				{#if data.people.shared_at === null}
					<label class="flex gap-3"
						><input type="checkbox" bind:checked={confirmSharing} required /><span
							>I understand this shares the whole project. Existing issue and schedule permissions
							start off, assigned agent work waits, and work already running may finish.</span
						></label
					>
				{/if}
				<button class="rounded border px-4 py-3" disabled={busy}>Send invitation</button>
			</form>
		</section>
		<section class="mt-6 rounded-lg border p-4" aria-labelledby="invites-heading">
			<h2 id="invites-heading" class="font-semibold">Invitations</h2>
			{#if data.invitations.length === 0}<p class="mt-3">No invitations yet.</p>{:else}
				<ul class="mt-3 space-y-3">
					{#each data.invitations as invitation (invitation.id)}
						<li class="border-t pt-3">
							<span
								>{invitation.email} · {invitation.accepted_at
									? 'Accepted'
									: invitation.canceled_at
										? 'Canceled'
										: invitation.delivery_status === 'failed'
											? 'Delivery failed'
											: 'Pending'} · expires {new Date(
									invitation.expires_at
								).toLocaleString()}</span
							>
							{#if !invitation.accepted_at && !invitation.canceled_at}
								<div class="mt-2 flex gap-2">
									<button
										class="rounded border px-3 py-2"
										disabled={busy}
										onclick={() =>
											request(
												`/api/v1/projects/${data.projectId}/invitations/${invitation.id}/resend`,
												'POST',
												{ expected_generation: invitation.generation }
											)}>Resend</button
									>
									<button
										class="rounded border px-3 py-2"
										disabled={busy}
										onclick={() =>
											request(
												`/api/v1/projects/${data.projectId}/invitations/${invitation.id}`,
												'DELETE',
												{ expected_generation: invitation.generation }
											)}>Cancel</button
									>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
</main>
