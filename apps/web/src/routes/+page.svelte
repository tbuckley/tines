<script lang="ts">
	import IconArrowsSplit2 from '@tabler/icons-svelte/icons/arrows-split-2';
	import { authClient } from '$lib/auth-client';
	import { Button } from '$lib/components/ui/button/index.js';

	async function signIn() {
		await authClient.signIn.social({ provider: 'google', callbackURL: '/issues' });
	}
</script>

<main class="flex min-h-screen flex-col items-center justify-center gap-8 p-8">
	<div class="flex flex-col items-center gap-3 text-center">
		<div class="bg-primary text-primary-foreground flex size-12 items-center justify-center rounded-xl">
			<IconArrowsSplit2 size={26} stroke={1.75} />
		</div>
		<h1 class="text-4xl font-bold tracking-tight">Tines</h1>
		<p class="text-muted-foreground max-w-md text-balance">
			An issue tracker for humans and their agents — work moves through workflows, and every
			action is on the record.
		</p>
	</div>
	<Button size="lg" onclick={signIn}>Sign in with Google</Button>
</main>
