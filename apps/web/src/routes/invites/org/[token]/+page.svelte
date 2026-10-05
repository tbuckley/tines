<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { authClient } from '$lib/auth-client';
	import MarketingSignIn from '$lib/components/marketing/MarketingSignIn.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	let { data } = $props();
	let signIn = $state<MarketingSignIn>();
	let pending = $state(false);
	let error = $state<string | null>(null);
	const returnTo = $derived(`/invites/org/${data.token}`);
	async function accept() {
		pending = true;
		error = null;
		try {
			const response = await fetch('/api/v1/organization-invitations/accept', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token: data.token })
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error?.message ?? 'Could not accept invitation');
			await invalidateAll();
			await goto(`/organizations/${result.organization_id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not accept invitation';
		} finally {
			pending = false;
		}
	}
	async function switchAccount() {
		await authClient.signOut();
		await invalidateAll();
		await goto(returnTo);
	}
</script>

<main class="mx-auto flex min-h-screen max-w-xl items-center px-5 py-12">
	<section class="bg-card w-full rounded-xl border p-6 shadow-sm">
		<h1 class="text-2xl font-semibold">Join {data.invitation.organization.name}</h1>
		<p class="mt-3">
			{data.invitation.organization.owner} invited you to the {data.invitation.organization.name} organization.
			Everyone in it works in every project in it. Your own context, workflows and settings stay in your
			personal organization.
		</p>
		<p class="text-muted-foreground mt-3 text-sm">
			This link expires {new Date(data.invitation.expires_at).toLocaleString()}.
		</p>
		{#if data.invitation.status === 'expired'}
			<p class="mt-5" role="status">This invitation link expired. Ask for a new one.</p>
		{:else if !data.invitation.signed_in}
			<Button class="mt-5" onclick={(event) => signIn?.open(event.currentTarget)}
				>Sign in to continue</Button
			>
		{:else if !data.invitation.matching_account}
			<p class="mt-5" role="status">
				Switch to the verified account that received this invitation.
			</p>
			<Button class="mt-3" onclick={switchAccount}>Switch account</Button>
		{:else}
			<Button class="mt-5" disabled={pending} onclick={accept}
				>{data.invitation.status === 'accepted'
					? 'Open organization'
					: pending
						? 'Joining…'
						: 'Join organization'}</Button
			>
		{/if}
		{#if error}<p class="text-destructive mt-3" role="alert">{error}</p>{/if}
	</section>
</main>
{#if !data.invitation.signed_in}<MarketingSignIn bind:this={signIn} {returnTo} />{/if}
