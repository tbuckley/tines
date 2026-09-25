<script lang="ts">
	import IconArrowsSplit2 from '@tabler/icons-svelte/icons/arrows-split-2';
	import IconListDetails from '@tabler/icons-svelte/icons/list-details';
	import IconLogout from '@tabler/icons-svelte/icons/logout';
	import IconRobot from '@tabler/icons-svelte/icons/robot';
	import IconSettings from '@tabler/icons-svelte/icons/settings';
	import IconSitemap from '@tabler/icons-svelte/icons/sitemap';
	import {
		afterNavigate,
		beforeNavigate,
		goto,
		invalidate,
		invalidateAll,
		onNavigate
	} from '$app/navigation';
	import { navigating, page } from '$app/state';
	import { api } from '$lib/api';
	import { authClient } from '$lib/auth-client';
	import ProjectSwitcher from '$lib/components/ProjectSwitcher.svelte';
	import { focusHint } from '$lib/focus.svelte';
	import { resolveClientFocus } from '$lib/focus';
	import { prefersReducedMotion } from '$lib/format';
	import { navMemory } from '$lib/nav-memory.svelte';
	import { dataTiming, record, viewportClass } from '$lib/perf/telemetry';
	import { fade } from 'svelte/transition';

	let { data, children } = $props();

	// `path` identifies the tab (active state, slide direction, keys); `href` is
	// where it goes — the Issues tab carries the filters you last used, so the
	// list comes back as you left it. Derived so it tracks the store: the
	// layout outlives every navigation.
	const focus = $derived(
		resolveClientFocus(focusHint.project, data.focus, [...data.projects, ...data.sharedProjects])
	);

	const tabs = $derived([
		{ path: '/issues', href: navMemory.issuesHref, label: 'Issues', icon: IconListDetails },
		{ path: '/workflows', href: '/workflows', label: 'Workflows', icon: IconSitemap },
		{ path: '/agents', href: '/agents', label: 'Agents', icon: IconRobot }
	]);

	// The chrome's answer to "what am I looking at": the layout's own data,
	// unless the client has set the focus since (opening a project page does),
	// which it records as a hint rather than paying for a load rerun.
	async function chooseFocus(projectId: string | null) {
		const predecessor = focusHint.predecessor();
		const write = predecessor.then(async () => {
			await api.updatePreferences({ focused_project_id: projectId });
			// A navigation that began while this write was pending can reuse the
			// resident layout node. Keep its chrome aligned with the freshly loaded
			// child data until a later layout refresh replaces the hint.
			if (navigating.to) {
				focusHint.set(
					[...data.projects, ...data.sharedProjects].find(
						(project: { id: string }) => project.id === projectId
					) ?? null
				);
			} else {
				focusHint.clear();
			}
		});
		focusHint.track(write);
		await write;
		// Every focus-aware load shares this dependency, including children that
		// read the app layout through parent(). A navigation already waiting on
		// this write will load that dependency itself; invalidating the resident
		// page at the same time can supersede the navigation.
		if (!navigating.to) await invalidate('app:preferences');
	}

	let menuOpen = $state(false);

	async function signOut() {
		menuOpen = false;
		await authClient.signOut();
		await invalidateAll();
		await goto('/');
	}

	// Real-user navigation latency (docs/PERFORMANCE.md, "Real users"): click
	// to new page mounted, per route, plus how much of it was spent waiting on
	// the data request and what the server said that request cost.
	let navStartedAt: number | null = null;
	beforeNavigate((navigation) => {
		navStartedAt = navigation.willUnload ? null : performance.now();
	});
	afterNavigate((navigation) => {
		const route = navigation.to?.route.id;
		if (!route || !navigation.to) return;
		const enter = navigation.type === 'enter';
		const startedAt = enter ? 0 : navStartedAt;
		navStartedAt = null;
		if (startedAt === null) return;
		const data = dataTiming(navigation.to.url.pathname, startedAt);
		record({
			k: 'nav',
			route,
			from: navigation.from?.route.id ?? '',
			type: navigation.type,
			ms: Math.round(performance.now() - startedAt),
			...data,
			vp: viewportClass()
		});
	});

	// Shared-element page transitions (View Transitions API where available).
	//
	// SvelteKit calls this only once the new page's `load` has resolved (the
	// old page sits unchanged until then), so the transition itself adds no
	// wait, but everything a page `load` *awaits* is time the click appears to
	// do nothing. Panels a page streams
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
		return tabs.findIndex((tab) => pathname.startsWith(tab.path));
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
	<!--
		The header and bottom bar get their own transition groups (see app.css):
		<main> is the named `page` group, and every named group paints above the
		root snapshot, so chrome left in root would vanish under the sliding page.
	-->
	<header
		class="bg-background/90 sticky top-0 z-40 border-b backdrop-blur"
		style:view-transition-name="app-header"
	>
		<div class="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4">
			<a href="/issues" class="flex shrink-0 items-center gap-2 font-semibold tracking-tight">
				<span
					class="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-lg"
				>
					<IconArrowsSplit2 size={16} stroke={2} />
				</span>
				Tines
			</a>
			<ProjectSwitcher
				projects={[...data.projects, ...data.sharedProjects]}
				{focus}
				onchoose={chooseFocus}
			/>
			<!-- Below md the tabs live in the bottom bar instead. -->
			<nav class="hidden h-full items-center gap-1 md:flex">
				{#each tabs as tab (tab.path)}
					{@const active = page.url.pathname.startsWith(tab.path)}
					<a
						href={tab.href}
						aria-current={active ? 'page' : undefined}
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
						<img
							src={data.user.image}
							alt=""
							class="size-8 rounded-full border"
							referrerpolicy="no-referrer"
						/>
					{:else}
						<span
							class="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-full border text-xs font-semibold"
						>
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
						<!--
							One entry, not one per page: the settings pages carry their own tab row
							(settings/+layout.svelte). This points at the first tab, which is also
							where a bare /settings redirects.
						-->
						<a
							href="/settings/appearance"
							class="hover:bg-accent hover:text-accent-foreground flex items-center gap-2 rounded-md px-3 py-2 text-sm"
							role="menuitem"
							onclick={() => (menuOpen = false)}
						>
							<IconSettings size={16} stroke={1.75} /> Settings
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
		class="mx-auto w-full max-w-6xl flex-1 px-4 py-8 pb-[calc(6rem+env(safe-area-inset-bottom,0px))] md:pb-8"
		style:view-transition-name="page"
	>
		{@render children()}
	</main>

	<!-- Compact chrome bottom tab bar below md. -->
	<nav
		class="bg-background/95 fixed inset-x-0 bottom-0 z-40 border-t backdrop-blur md:hidden"
		style="padding-bottom: env(safe-area-inset-bottom)"
		aria-label="Primary"
		style:view-transition-name="tab-bar"
	>
		<div class="grid h-16 grid-cols-3">
			{#each tabs as tab (tab.path)}
				{@const active = mobileTabPath.startsWith(tab.path)}
				{@const pending = active && !page.url.pathname.startsWith(tab.path)}
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
