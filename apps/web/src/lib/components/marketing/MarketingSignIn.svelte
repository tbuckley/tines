<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { authClient } from '$lib/auth-client';

	let {
		linkError = null,
		onOpened,
		returnTo = '/issues',
		errorReturnTo
	}: {
		linkError?: string | null;
		onOpened?: () => void;
		returnTo?: string;
		errorReturnTo?: string;
	} = $props();
	let dialog: HTMLDialogElement;
	let emailInput = $state<HTMLInputElement>();
	let email = $state('');
	let pending = $state(false);
	let sentTo = $state<string | null>(null);
	let status = $state<string | null>(null);
	let attempt = 0;
	let opener: HTMLElement | null = null;

	export function open(trigger?: HTMLElement) {
		opener = trigger ?? null;
		attempt += 1;
		pending = false;
		sentTo = null;
		status = linkError;
		if (!dialog.open) dialog.showModal();
		onOpened?.();
	}

	function close() {
		dialog.close();
	}

	function handleClose() {
		attempt += 1;
		pending = false;
		if (opener?.isConnected) opener.focus();
	}

	async function signInWithGoogle() {
		const generation = ++attempt;
		pending = true;
		status = 'Opening Google sign-in…';
		try {
			const { error } = await authClient.signIn.social({
				provider: 'google',
				callbackURL: returnTo
			});
			if (generation !== attempt || !dialog.open) return;
			if (error) status = error.message ?? 'Could not connect to Google. Try again.';
		} catch {
			if (generation === attempt && dialog.open) status = 'Could not connect to Google. Try again.';
		} finally {
			if (generation === attempt && dialog.open) pending = false;
		}
	}

	async function sendMagicLink(event: SubmitEvent) {
		event.preventDefault();
		const submittedEmail = email;
		const generation = ++attempt;
		pending = true;
		status = 'Preparing your sign-in link…';
		try {
			const { error } = await authClient.signIn.magicLink({
				email: submittedEmail,
				name: submittedEmail.split('@')[0],
				callbackURL: returnTo,
				errorCallbackURL:
					errorReturnTo ?? `${returnTo}${returnTo.includes('?') ? '&' : '?'}error=signin`
			});
			if (generation !== attempt || !dialog.open) return;
			if (error) status = error.message ?? 'Could not send the sign-in link. Try again.';
			else {
				sentTo = submittedEmail;
				status = null;
			}
		} catch {
			if (generation === attempt && dialog.open)
				status = 'Could not send the sign-in link. Try again.';
		} finally {
			if (generation === attempt && dialog.open) pending = false;
		}
	}

	async function retry() {
		attempt += 1;
		sentTo = null;
		status = null;
		await tick();
		emailInput?.focus();
	}

	onMount(() => {
		if (linkError) open();
	});
	onDestroy(() => (attempt += 1));
</script>

<dialog bind:this={dialog} aria-labelledby="signin-title" onclose={handleClose}>
	<button class="close" aria-label="Close sign-in" onclick={close}>×</button>
	<h2 id="signin-title">Sign in to Tines.</h2>
	{#if sentTo}
		<div class="sent-state">
			<strong>Check your email</strong>
			<p>We sent a sign-in link to <b>{sentTo}</b>. It expires in 10 minutes.</p>
			<button id="retry" onclick={retry}>Use a different email</button>
		</div>
	{:else}
		<button id="google" disabled={pending} onclick={signInWithGoogle}>Continue with Google</button>
		<form id="email-form" aria-busy={pending} onsubmit={sendMagicLink}>
			<label for="email">Or use a magic link</label>
			<input
				bind:this={emailInput}
				bind:value={email}
				type="email"
				id="email"
				required
				autocomplete="email"
				placeholder="you@example.com"
				disabled={pending}
			/>
			<button disabled={pending}>{pending ? 'Sending link…' : 'Email me a sign-in link'}</button>
		</form>
	{/if}
	{#if status}<p id="signin-status" role="status" aria-live="polite">{status}</p>{/if}
</dialog>
