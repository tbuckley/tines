<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { authClient } from '$lib/auth-client';
	import { Button } from '$lib/components/ui/button/index.js';

	let { data } = $props();

	async function signIn() {
		await authClient.signIn.social({ provider: 'google', callbackURL: '/' });
	}

	async function signOut() {
		await authClient.signOut();
		await invalidateAll();
	}
</script>

<main class="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
	<h1 class="text-4xl font-bold tracking-tight">Hello, world 👋</h1>

	{#if data.user}
		<p class="text-muted-foreground">
			Signed in as <span class="text-foreground font-medium">{data.user.name}</span>
			({data.user.email})
		</p>
		<Button variant="outline" onclick={signOut}>Sign out</Button>
	{:else}
		<p class="text-muted-foreground">You are not signed in.</p>
		<Button onclick={signIn}>Sign in with Google</Button>
	{/if}

	<p class="text-muted-foreground text-sm">
		Server time from <code class="bg-muted rounded px-1.5 py-0.5">/api/time</code>:
		<span class="text-foreground font-mono">{data.time.time}</span>
	</p>
</main>
