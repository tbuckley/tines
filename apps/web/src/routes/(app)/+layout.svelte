<script lang="ts">
	import IconActivity from '@tabler/icons-svelte/icons/activity';
	import IconArrowsSplit2 from '@tabler/icons-svelte/icons/arrows-split-2';
	import IconBooks from '@tabler/icons-svelte/icons/books';
	import IconDatabaseExport from '@tabler/icons-svelte/icons/database-export';
	import IconFolder from '@tabler/icons-svelte/icons/folder';
	import IconKey from '@tabler/icons-svelte/icons/key';
	import IconListDetails from '@tabler/icons-svelte/icons/list-details';
	import IconLogout from '@tabler/icons-svelte/icons/logout';
	import IconPalette from '@tabler/icons-svelte/icons/palette';
	import IconRobot from '@tabler/icons-svelte/icons/robot';
	import IconSitemap from '@tabler/icons-svelte/icons/sitemap';
	import { goto, invalidateAll, onNavigate } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import { authClient } from '$lib/auth-client';
	import { prefersReducedMotion } from '$lib/format';
	import { fade } from 'svelte/transition';

	let { data, children } = $props();

	const tabs = [
		{ href: '/issues', label: 'Issues', icon: IconListDetails },
		{ href: '/workflows', label: 'Workflows', icon: IconSitemap },
		{ href: '/projects', label: 'Projects', icon: IconFolder },
		{ href: '/context', label: 'Context', icon: IconBooks },
		{ href: '/agents', label: 'Agents', icon: IconRobot },
		{ href: '/activity', label: 'Activity', icon: IconActivity }
	];

	let menuOpen = $state(false);

	async function signOut() {
		menuOpen = false;
		await authClient.signOut();
		await invalidateAll();
		await goto('/');
	}

	// Shared-element page transitions (View Transitions API where available).
	//
	// The old page stays frozen until `navigation.complete`, so this turns
	// server latency straight into perceived latency: the transition is only as
	// fast as the slowest thing a page `load` *awaits*. Panels a page streams
	// (returned as promises under `data.deferred`) are not part of it and land
	// after the commit — which is why the issue page awaits only its first D1
	// wave. Keep it that way when adding data to a load.
	onNavigate((navigation) => {
		if (!document.startViewTransition || prefersReducedMotion()) return;

		// When moving between top-level tabs, record the direction so the
		// phone-width CSS in app.css can slide the page toward it. Desktop
		// ignores the attribute and keeps the crossfade.
		const from = tabIndex(navigation.from?.url.pathname);
		const to = tabIndex(navigation.to?.url.pathname);
		if (from !== -1 && to !== -1 && from !== to) {
			document.documentElement.dataset.tabSlide = to > from ? 'forward' : 'back';
		}

		return new Promise((resolve) => {
			const transition = document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
			});
			transition.finished.finally(() => {
				delete document.documentElement.dataset.tabSlide;
			});
		});
	});

	function tabIndex(pathname: string | undefined) {
		if (!pathname) return -1;
		return tabs.findIndex((tab) => pathname.startsWith(tab.href));
	}

	// The bottom bar highlights the destination tab the moment navigation
	// starts, so a tap is acknowledged even while the next page's data is
	// still loading; the pending tab pulses until the switch lands.
	const mobileTabPath = $derived(navigating.to?.url.pathname ?? page.url.pathname);

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
			<!-- On phones the tabs live in the bottom bar instead. -->
			<nav class="hidden h-full items-center gap-1 sm:flex">
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
							href="/settings/appearance"
							class="hover:bg-accent hover:text-accent-foreground flex items-center gap-2 rounded-md px-3 py-2 text-sm"
							role="menuitem"
							onclick={() => (menuOpen = false)}
						>
							<IconPalette size={16} stroke={1.75} /> Appearance
						</a>
						<a
							href="/settings/export-import"
							class="hover:bg-accent hover:text-accent-foreground flex items-center gap-2 rounded-md px-3 py-2 text-sm"
							role="menuitem"
							onclick={() => (menuOpen = false)}
						>
							<IconDatabaseExport size={16} stroke={1.75} /> Export / import
						</a>
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

	<!-- Named group so tab slides move the page content but not the chrome. -->
	<main
		class="mx-auto w-full max-w-6xl flex-1 px-4 py-8 pb-24 sm:pb-8"
		style:view-transition-name="page"
	>
		{@render children()}
	</main>

	<!-- mobile bottom tab bar -->
	<nav
		class="bg-background/95 fixed inset-x-0 bottom-0 z-40 border-t backdrop-blur sm:hidden"
		style="padding-bottom: env(safe-area-inset-bottom)"
		aria-label="Primary"
	>
		<div class="grid h-16 grid-cols-6">
			{#each tabs as tab (tab.href)}
				{@const active = mobileTabPath.startsWith(tab.href)}
				{@const pending = active && !page.url.pathname.startsWith(tab.href)}
				<a
					href={tab.href}
					class="flex flex-col items-center justify-center gap-1 text-[0.6875rem] font-medium transition active:scale-90 {active
						? 'text-foreground'
						: 'text-muted-foreground'}"
					aria-current={active ? 'page' : undefined}
				>
					<span class={pending ? 'motion-safe:animate-pulse' : ''}>
						<tab.icon size={20} stroke={active ? 2 : 1.5} />
					</span>
					{tab.label}
				</a>
			{/each}
		</div>
	</nav>
</div>
