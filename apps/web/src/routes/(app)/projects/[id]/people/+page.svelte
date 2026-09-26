<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import IconAlertTriangle from '@tabler/icons-svelte/icons/alert-triangle';
	import IconChevronLeft from '@tabler/icons-svelte/icons/chevron-left';
	import IconClock from '@tabler/icons-svelte/icons/clock';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import PersonalPermissionWarning from '$lib/components/PersonalPermissionWarning.svelte';
	import { formatDateTime, invitationExpiryLabel, invitationStatus, joinedDate } from '$lib/format';
	let { data } = $props();
	// An accepted invitation is a member now: it shows in the roster, not here.
	const openInvitations = $derived(data.invitations.filter((i) => i.accepted_at === null));
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

<main class="mx-auto max-w-3xl">
	<a
		class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
		href={`/projects/${data.projectId}`}><IconChevronLeft size={16} />{data.project.name}</a
	>
	<h1 class="mt-5 text-2xl font-semibold">People</h1>
	<p class="text-muted-foreground mt-2">
		Members work on everything in the project except adding or removing people. Their agents cannot
		run here in this release.
	</p>
	{#if message}<p class="mt-4" role="status">{message}</p>{/if}
	<section class="mt-6 rounded-lg border p-4" aria-labelledby="roster-heading">
		<h2 id="roster-heading" class="font-semibold">Project members</h2>
		<ul class="mt-3 space-y-4">
			<li>
				{data.people.owner.name}
				<span class="text-muted-foreground"
					>Owner{data.people.owner.id === data.viewerId ? ' · You' : ''}</span
				>
			</li>
			{#each data.people.members as member (member.id)}
				<li class="flex flex-wrap items-center justify-between gap-2">
					<span
						>{member.name}
						<span class="text-muted-foreground"
							>Member · joined {joinedDate(member.joined_at)}{member.id === data.viewerId
								? ' · You'
								: ''}</span
						></span
					>
					{#if data.role === 'owner'}<Button
							size="sm"
							variant="outline"
							disabled={busy}
							onclick={() =>
								request(`/api/v1/projects/${data.projectId}/members/${member.id}`, 'DELETE', {
									expected_revision: member.revision
								})}>Remove</Button
						>{/if}
				</li>
			{/each}
		</ul>
		{#if data.role === 'member'}<Button
				class="mt-5"
				variant="outline"
				disabled={busy}
				onclick={leave}>Leave project</Button
			>{/if}
	</section>
	{#if data.role === 'owner'}
		<section class="mt-6 rounded-lg border p-4" aria-labelledby="invite-heading">
			<h2 id="invite-heading" class="font-semibold">Invite someone</h2>
			<form class="mt-3 space-y-4" onsubmit={invite}>
				<label class="block"
					>Verified email<Input class="mt-1" type="email" bind:value={email} required /></label
				>
				<label class="block"
					>Landing issue ID (optional)<Input class="mt-1" bind:value={issueId} /></label
				>
				{#if data.people.shared_at === null}
					<label class="flex items-start gap-3 text-sm"
						><input
							type="checkbox"
							class="mt-0.5 size-4 shrink-0"
							bind:checked={confirmSharing}
							required
						/><span
							>I understand this shares the whole project. My agents keep working on its issues and
							schedules unless I turn them off; members' agents need their own permission and cannot
							run in this release. Assigned agent work is restarted, and work already running may
							finish.</span
						></label
					>
					<PersonalPermissionWarning role="owner" />
				{/if}
				<Button type="submit" disabled={busy}>Send invitation</Button>
			</form>
		</section>
		<section class="mt-6 rounded-lg border p-4" aria-labelledby="invites-heading">
			<h2 id="invites-heading" class="font-semibold">Invitations</h2>
			{#if openInvitations.length === 0}<p class="mt-3">No pending invitations.</p>{:else}
				<ul class="mt-3 space-y-4">
					{#each openInvitations as invitation (invitation.id)}
						{@const status = invitationStatus(invitation)}
						<li class="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-sm">
							<div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
								<span class="break-all">{invitation.email}</span>
								{#if status === 'pending'}
									<span
										class="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
										><IconClock size={12} stroke={2} /> Pending</span
									>
								{:else if status === 'failed'}
									<span
										class="bg-destructive/10 text-destructive flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
										><IconAlertTriangle size={12} stroke={2} /> Delivery failed</span
									>
								{:else if status === 'expired'}
									<span
										class="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-medium"
										>Expired</span
									>
								{:else}
									<span
										class="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-medium"
										>Canceled</span
									>
								{/if}
								{#if status !== 'canceled'}
									<time
										class="text-muted-foreground"
										datetime={new Date(invitation.expires_at).toISOString()}
										title={formatDateTime(invitation.expires_at)}
										>{invitationExpiryLabel(invitation.expires_at)}</time
									>
								{/if}
							</div>
							{#if status !== 'canceled'}
								<div class="flex gap-2">
									<Button
										size="sm"
										variant="outline"
										disabled={busy}
										onclick={() =>
											request(
												`/api/v1/projects/${data.projectId}/invitations/${invitation.id}/resend`,
												'POST',
												{ expected_generation: invitation.generation }
											)}>Resend</Button
									>
									<Button
										size="sm"
										variant="outline"
										disabled={busy}
										onclick={() =>
											request(
												`/api/v1/projects/${data.projectId}/invitations/${invitation.id}`,
												'DELETE',
												{ expected_generation: invitation.generation }
											)}>Cancel</Button
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
