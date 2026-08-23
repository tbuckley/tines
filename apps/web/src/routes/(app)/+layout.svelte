<script lang="ts">
	import IconArrowsSplit2 from '@tabler/icons-svelte/icons/arrows-split-2';
	import IconKey from '@tabler/icons-svelte/icons/key';
	import IconLogout from '@tabler/icons-svelte/icons/logout';
	import { goto, invalidateAll, onNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { authClient } from '$lib/auth-client';
	import { prefersReducedMotion } from '$lib/format';
	import { fade } from 'svelte/transition';

	let { data, children } = $props();

	const tabs = [
		{ href: '/issues', label: 'Issues' },
		{ href: '/workflows', label: 'Workflows' },
		{ href: '/projects', label: 'Projects' },
		{ href: '/activity', label: 'Activity' }
	];

	let menuOpen = $state(false);

	async function signOut() {
		menuOpen = false;
		await authClient.signOut();
		await invalidateAll();
		await goto('/');
	}

	// Shared-element page transitions (View Transitions API where available).
	onNavigate((navigation) => {
		if (!document.startViewTransition || prefersReducedMotion()) return;
		return new Promise((resolve) => {
			document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
			});
		});
	});

	const initials = $derived(
		data.user.name
			.split(/\s+/)
			.map((w: string) => w[0])
			.slice(0, 2)
			.join('')
			.toUpperCase()
	);
</script>

<svelte:window onclick={() => (menuOpen = false)} />

<div class="flex min-h-screen flex-col">
	<header class="bg-background/90 sticky top-0 z-40 border-b backdrop-blur">
		<div class="mx-auto flex h-14 w-full max-w-6xl items-center gap-6 px-4">
			<a href="/issues" class="flex items-center gap-2 font-semibold tracking-tight">
				<span class="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-lg">
					<IconArrowsSplit2 size={16} stroke={2} />
				</span>
				Tines
			</a>
			<nav class="flex h-full items-center gap-1">
				{#each tabs as tab (tab.href)}
					{@const active = page.url.pathname.startsWith(tab.href)}
					<a
						href={tab.href}
						class="relative flex h-full items-center px-3 text-sm font-medium transition-colors {active
							? 'text-foreground'
							: 'text-muted-foreground hover:text-foreground'}"
					>
						{tab.label}
						{#if active}
							<span
								class="bg-primary absolute inset-x-3 bottom-0 h-0.5 rounded-full"
								style:view-transition-name="nav-underline"
							></span>
						{/if}
					</a>
				{/each}
			</nav>
			<div class="relative ml-auto">
				<button
					class="focus-visible:ring-ring/50 flex items-center rounded-full outline-none focus-visible:ring-[3px]"
					onclick={(e) => {
						e.stopPropagation();
						menuOpen = !menuOpen;
					}}
					aria-haspopup="menu"
					aria-expanded={menuOpen}
					aria-label="Account menu"
				>
					{#if data.user.image}
						<img src={data.user.image} alt="" class="size-8 rounded-full border" referrerpolicy="no-referrer" />
					{:else}
						<span class="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-full border text-xs font-semibold">
							{initials}
						</span>
					{/if}
				</button>
				{#if menuOpen}
					<div
						class="bg-popover text-popover-foreground absolute right-0 z-50 mt-2 w-56 rounded-lg border p-1 shadow-md"
						transition:fade={{ duration: prefersReducedMotion() ? 0 : 120 }}
						role="menu"
					>
						<div class="px-3 py-2">
							<p class="truncate text-sm font-medium">{data.user.name}</p>
							<p class="text-muted-foreground truncate text-xs">{data.user.email}</p>
						</div>
						<div class="bg-border my-1 h-px"></div>
						<a
							href="/settings/api-keys"
							class="hover:bg-accent hover:text-accent-foreground flex items-center gap-2 rounded-md px-3 py-2 text-sm"
							role="menuitem"
							onclick={() => (menuOpen = false)}
						>
							<IconKey size={16} stroke={1.75} /> API keys
						</a>
						<button
							class="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm"
							role="menuitem"
							onclick={signOut}
						>
							<IconLogout size={16} stroke={1.75} /> Sign out
						</button>
					</div>
				{/if}
			</div>
		</div>
	</header>

	<main class="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
		{@render children()}
	</main>
</div>
