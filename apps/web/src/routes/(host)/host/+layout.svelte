<script lang="ts">
	import { goto } from '$app/navigation';
	import { authClient } from '$lib/auth-client';
	let { data, children } = $props();
	async function signOut() {
		await authClient.signOut();
		await goto('/');
	}
</script>

<header class="border-b">
	<nav
		class="mx-auto flex min-h-14 max-w-6xl items-center justify-between gap-4 px-4"
		aria-label="Host moderation"
	>
		<a class="font-semibold" href="/host/workflow-reports">Workflow moderation</a>
		<div class="flex items-center gap-3 text-sm">
			<a class="underline" href="/issues">Back to Tines</a>
			<button class="min-h-10 rounded-md border px-3" onclick={signOut}
				>Sign out {data.user.name}</button
			>
		</div>
	</nav>
</header>
<main class="mx-auto max-w-6xl px-4 py-8">{@render children()}</main>
