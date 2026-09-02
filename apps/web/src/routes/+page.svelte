<script lang="ts">
	import IconArrowsSplit2 from '@tabler/icons-svelte/icons/arrows-split-2';
	import IconMailFilled from '@tabler/icons-svelte/icons/mail-filled';
	import { page } from '$app/state';
	import { authClient } from '$lib/auth-client';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';

	let email = $state('');
	let sending = $state(false);
	let sentTo = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);

	const linkError = $derived(
		page.url.searchParams.has('error')
			? 'That sign-in link is invalid or has expired. Enter your email to get a new one.'
			: null
	);

	async function signInWithGoogle() {
		await authClient.signIn.social({ provider: 'google', callbackURL: '/issues' });
	}

	async function sendMagicLink(e: SubmitEvent) {
		e.preventDefault();
		sending = true;
		errorMessage = null;
		const { error } = await authClient.signIn.magicLink({
			email,
			name: email.split('@')[0],
			callbackURL: '/issues',
			errorCallbackURL: '/'
		});
		sending = false;
		if (error) {
			errorMessage = error.message ?? 'Could not send the sign-in link. Try again.';
		} else {
			sentTo = email;
		}
	}
</script>

<main class="flex min-h-screen flex-col items-center justify-center gap-8 p-8">
	<div class="flex flex-col items-center gap-3 text-center">
		<div
			class="bg-primary text-primary-foreground flex size-12 items-center justify-center rounded-xl"
		>
			<IconArrowsSplit2 size={26} stroke={1.75} />
		</div>
		<h1 class="text-4xl font-bold tracking-tight">Tines</h1>
		<p class="text-muted-foreground max-w-md text-balance">
			An issue tracker for humans and their agents — work moves through workflows, and every action
			is on the record.
		</p>
	</div>

	<div class="flex w-full max-w-sm flex-col items-center gap-4">
		{#if sentTo}
			<div class="flex flex-col items-center gap-2 text-center">
				<IconMailFilled size={28} stroke={1.5} class="text-primary" />
				<p class="font-medium">Check your email</p>
				<p class="text-muted-foreground text-sm text-balance">
					We sent a sign-in link to <span class="text-foreground font-medium">{sentTo}</span>. It
					expires in 10 minutes.
				</p>
				<Button variant="ghost" size="sm" onclick={() => (sentTo = null)}
					>Use a different email</Button
				>
			</div>
		{:else}
			<form class="flex w-full flex-col gap-2" onsubmit={sendMagicLink}>
				<Input
					type="email"
					name="email"
					placeholder="you@example.com"
					required
					autocomplete="email"
					bind:value={email}
					disabled={sending}
				/>
				<Button type="submit" disabled={sending}>
					{sending ? 'Sending link…' : 'Email me a sign-in link'}
				</Button>
			</form>
			{#if errorMessage}
				<p class="text-destructive text-sm">{errorMessage}</p>
			{:else if linkError}
				<p class="text-destructive text-sm text-balance">{linkError}</p>
			{/if}
			<div class="text-muted-foreground flex w-full items-center gap-3 text-xs uppercase">
				<div class="bg-border h-px flex-1"></div>
				or
				<div class="bg-border h-px flex-1"></div>
			</div>
			<Button variant="outline" class="w-full" onclick={signInWithGoogle}
				>Sign in with Google</Button
			>
		{/if}
	</div>
</main>
