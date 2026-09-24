<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { authClient } from '$lib/auth-client';
	import MarketingSignIn from '$lib/components/marketing/MarketingSignIn.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	let { data } = $props();
	let signIn = $state<MarketingSignIn>();
	let pending = $state(false);
	let error = $state<string | null>(null);
	const returnTo = $derived(`/invites/${data.token}`);
	async function accept() {
		pending = true;
		error = null;
		try {
			const response = await fetch('/api/v1/invitations/accept', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token: data.token })
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error?.message ?? 'Could not accept invitation');
			await invalidateAll();
			await goto(result.landing_path);
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
		<h1 class="text-2xl font-semibold">Join {data.invitation.project.name}</h1>
		<p class="mt-3">
			{data.invitation.project.owner} invited you to the whole project. Members work on its issues and
			schedules alongside the owner; only the owner adds or removes people.
		</p>
		<p class="text-muted-foreground mt-3 text-sm">
			This link expires {new Date(data.invitation.expires_at).toLocaleString()}. Once you join, you
			stay a member until the owner removes you or you leave.
		</p>
		{#if data.invitation.status === 'expired'}
			<p class="mt-5" role="status">This invitation link expired. Ask the owner to resend it.</p>
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
			<p class="mt-5">Signed in as {data.invitation.email}.</p>
			<Button class="mt-3" disabled={pending} onclick={accept}
				>{data.invitation.status === 'accepted'
					? 'Open project'
					: pending
						? 'Joining…'
						: 'Join project'}</Button
			>
		{/if}
		{#if error}<p class="text-destructive mt-3" role="alert">{error}</p>{/if}
	</section>
</main>
{#if !data.invitation.signed_in}<MarketingSignIn bind:this={signIn} {returnTo} />{/if}
