<script lang="ts" module>
	/** The list filters a page parses from its URL, as the bar reads them. */
	export interface IssueFilterState {
		project?: string;
		category?: string;
		state?: string;
		/** Label ids or names, as they appear in the URL. */
		labels: string[];
		showDone: boolean;
		ready: boolean;
		q?: string;
	}
</script>

<script lang="ts">
	import { Popover } from 'bits-ui';
	import IconCheck from '@tabler/icons-svelte/icons/check';
	import IconFilter from '@tabler/icons-svelte/icons/filter';
	import IconSearch from '@tabler/icons-svelte/icons/search';
	import IconX from '@tabler/icons-svelte/icons/x';
	import type { Label, Project, StateCategory, WorkflowResponse } from '@tines/shared';
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import CheckboxField from '$lib/components/CheckboxField.svelte';
	import LabelChip from '$lib/components/LabelChip.svelte';
	import StateGlyph from '$lib/components/StateGlyph.svelte';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import { CATEGORY_LABELS, categoryVar } from '$lib/format';

	let {
		filters,
		counts,
		labels,
		workflows,
		projects
	}: {
		filters: IssueFilterState;
		/** Issues per category under every filter but the category itself. */
		counts: Record<StateCategory, number>;
		labels: Label[];
		workflows: WorkflowResponse[];
		/** Present on the all-issues list; the project page has no scope to pick. */
		projects?: Project[];
	} = $props();

	/**
	 * The URL is the source of truth for every filter, so each control
	 * rewrites the query string on the current path — the same bar serves
	 * `/issues` and `/projects/:id` — and the page's load reads it back.
	 */
	function navigate(mutate: (params: URLSearchParams) => void) {
		const params = new URLSearchParams(page.url.searchParams);
		mutate(params);
		const qs = params.toString();
		goto(`${page.url.pathname}${qs ? `?${qs}` : ''}`, { keepFocus: true, noScroll: true });
	}
	const set = (key: string, value: string) =>
		navigate((p) => (value ? p.set(key, value) : p.delete(key)));

	// --- Category tabs -----------------------------------------------------
	// "Open" is the default population (everything not done); the categories
	// are the rest. `done=1` with no category — everything, done included — has
	// no tab of its own, but stays reachable by URL and shows as "All" while on.
	const tabHref = (category: StateCategory | 'all' | null) => {
		const params = new URLSearchParams(page.url.searchParams);
		params.delete('category');
		params.delete('done');
		if (category === 'all') params.set('done', '1');
		else if (category) params.set('category', category);
		const qs = params.toString();
		return `${page.url.pathname}${qs ? `?${qs}` : ''}`;
	};
	const active = $derived(filters.category ?? (filters.showDone ? 'all' : 'open'));
	const openCount = $derived(counts.backlog + counts.active + counts.awaiting_human);
	const tabs = $derived([
		{ key: 'open', label: 'Open', short: 'Open', count: openCount, glyph: null },
		{ key: 'backlog', label: 'Backlog', short: 'Backlog', count: counts.backlog, glyph: 'backlog' },
		{ key: 'active', label: 'Active', short: 'Active', count: counts.active, glyph: 'active' },
		{
			key: 'awaiting_human',
			label: CATEGORY_LABELS.awaiting_human,
			short: 'Awaiting',
			count: counts.awaiting_human,
			glyph: 'awaiting_human'
		},
		{ key: 'done', label: 'Done', short: 'Done', count: counts.done, glyph: 'done' },
		...(active === 'all'
			? [{ key: 'all', label: 'All', short: 'All', count: openCount + counts.done, glyph: null }]
			: [])
	] as { key: string; label: string; short: string; count: number; glyph: StateCategory | null }[]);

	// --- The Filter menu: labels, state, ready ------------------------------
	let menuOpen = $state(false);
	let labelQuery = $state('');
	const labelMatches = $derived(
		labels.filter((l) => l.name.toLowerCase().includes(labelQuery.trim().toLowerCase()))
	);
	// The URL carries ids (a rename never breaks a bookmark) but accepts names.
	const selectedLabels = $derived(
		filters.labels
			.map((ref) => labels.find((l) => l.id === ref || l.name.toLowerCase() === ref.toLowerCase()))
			.filter((l) => l !== undefined)
	);
	const selectedIds = $derived(selectedLabels.map((l) => l.id));
	const setLabels = (ids: string[]) =>
		navigate((p) => {
			p.delete('label');
			for (const id of ids) p.append('label', id);
		});
	const toggleLabel = (id: string) =>
		setLabels(
			selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]
		);
	// Distinct state names across the library, for the state filter.
	const stateNames = $derived([...new Set(workflows.flatMap((w) => w.states.map((s) => s.name)))]);
	const menuCount = $derived(
		selectedLabels.length + (filters.state ? 1 : 0) + (filters.ready ? 1 : 0)
	);
	const clearMenu = () =>
		navigate((p) => {
			p.delete('label');
			p.delete('state');
			p.delete('ready');
		});

	// --- Search --------------------------------------------------------------
	// Submit-to-search, like the context page. The field follows the URL, so a
	// term cleared elsewhere (the × chip, a nav link) empties it too.
	let search = $state('');
	$effect(() => {
		search = filters.q ?? '';
	});
	let searchOpen = $state(false);
	let searchEl: HTMLInputElement | null = $state(null);
	const searchShown = $derived(searchOpen || Boolean(filters.q));
	async function openSearch() {
		searchOpen = true;
		await tick();
		searchEl?.focus();
	}
</script>

<!-- One line from `sm` up: scope, tabs, Filter and its chips, then search at
     the far right. On a phone, `order` rebuilds it as rows: scope + Filter +
     search button, then the tabs (wrapping to a second row), then any chips, then
     the search field when opened. -->
<div class="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2">
	{#if projects}
		<Select
			class="w-40 max-sm:min-w-0 max-sm:flex-1"
			value={filters.project ?? ''}
			onchange={(e) => set('project', e.currentTarget.value)}
			aria-label="Filter by project"
		>
			<option value="">All projects</option>
			{#each projects as project (project.id)}
				<option value={project.name}>{project.name}</option>
			{/each}
		</Select>
	{/if}

	<nav aria-label="Category" class="order-3 w-full sm:order-none sm:w-auto">
		<div
			class="bg-muted/60 flex flex-wrap items-center gap-0.5 rounded-md border p-[3px] sm:inline-flex sm:h-9 sm:flex-nowrap"
		>
			{#each tabs as tab (tab.key)}
				{@const on = active === tab.key}
				<a
					href={tabHref(tab.key === 'open' ? null : (tab.key as StateCategory | 'all'))}
					data-sveltekit-noscroll
					data-sveltekit-keepfocus
					aria-current={on ? 'page' : undefined}
					class="flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[13px] whitespace-nowrap transition-colors {on
						? 'bg-background text-foreground font-medium shadow-xs'
						: 'text-muted-foreground hover:text-foreground'}"
				>
					{#if tab.glyph}
						<span class="flex" style:color={categoryVar(tab.glyph)}>
							<StateGlyph category={tab.glyph} size={12} />
						</span>
					{/if}
					<span class="max-sm:hidden">{tab.label}</span>
					<span class="sm:hidden">{tab.short}</span>
					<span class="text-muted-foreground text-[11px] tabular-nums">{tab.count}</span>
				</a>
			{/each}
		</div>
	</nav>

	<Popover.Root bind:open={menuOpen}>
		<Popover.Trigger>
			{#snippet child({ props })}
				<button
					{...props}
					type="button"
					class="border-input hover:bg-accent flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm {menuCount >
					0
						? ''
						: 'text-muted-foreground'}"
					aria-label="Filter{menuCount > 0 ? `, ${menuCount} active` : ''}"
				>
					<IconFilter size={15} stroke={1.75} />
					Filter
					{#if menuCount > 0}
						<span
							class="bg-foreground text-background inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold"
							aria-hidden="true">{menuCount}</span
						>
					{/if}
				</button>
			{/snippet}
		</Popover.Trigger>
		<Popover.Portal>
			<Popover.Content
				sideOffset={6}
				align="start"
				collisionPadding={8}
				class="bg-popover text-popover-foreground data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 ring-foreground/10 z-50 w-72 rounded-lg p-1 shadow-md ring-1 outline-none"
			>
				<p
					class="text-muted-foreground px-2 pt-1.5 pb-1 text-[11px] font-medium tracking-wider uppercase"
				>
					Labels
				</p>
				{#if labels.length > 8}
					<input
						bind:value={labelQuery}
						placeholder="Filter labels…"
						aria-label="Filter labels"
						class="placeholder:text-muted-foreground mb-1 w-full rounded-md bg-transparent px-2 py-1 text-sm outline-none"
					/>
				{/if}
				<div class="max-h-48 overflow-y-auto">
					{#each labelMatches as label (label.id)}
						{@const on = selectedIds.includes(label.id)}
						<button
							type="button"
							class="hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left"
							aria-pressed={on}
							onclick={() => toggleLabel(label.id)}
						>
							<span class="text-primary flex size-4 shrink-0 items-center justify-center">
								{#if on}<IconCheck size={14} stroke={2.5} />{/if}
							</span>
							<LabelChip {label} variant="dot" class="min-w-0 truncate" />
						</button>
					{:else}
						<p class="text-muted-foreground px-2 py-2 text-xs">
							{labels.length === 0 ? 'No labels yet.' : 'No labels match.'}
						</p>
					{/each}
				</div>
				<p
					class="text-muted-foreground mt-1 border-t px-2 pt-2 pb-1 text-[11px] font-medium tracking-wider uppercase"
				>
					State
				</p>
				<div class="px-1 pb-1">
					<Select
						class="h-8 text-sm"
						value={filters.state ?? ''}
						onchange={(e) => set('state', e.currentTarget.value)}
						aria-label="Filter by state"
					>
						<option value="">Any state</option>
						{#each stateNames as name (name)}
							<option value={name}>{name}</option>
						{/each}
					</Select>
				</div>
				<div class="mt-1 border-t px-2 pt-2 pb-1.5">
					<!-- Ready implies not-done: with it on, the Done tab counts 0. -->
					<CheckboxField
						label="Ready only"
						class="text-sm"
						checked={filters.ready}
						onCheckedChange={(checked) => set('ready', checked ? '1' : '')}
					/>
					<p class="text-muted-foreground mt-0.5 pl-6 text-xs">
						Unblocked, not done, not a duplicate.
					</p>
				</div>
				{#if menuCount > 0}
					<div class="mt-1 border-t pt-1">
						<button
							type="button"
							class="text-muted-foreground hover:bg-accent hover:text-foreground w-full rounded-md px-2 py-1.5 text-left text-sm"
							onclick={clearMenu}
						>
							Clear filters
						</button>
					</div>
				{/if}
			</Popover.Content>
		</Popover.Portal>
	</Popover.Root>

	{#if menuCount > 0}
		<!-- Every active pick from the menu, visible without opening it. -->
		<div class="order-4 flex w-full flex-wrap items-center gap-1.5 sm:contents">
			{#each selectedLabels as label (label.id)}
				<button
					type="button"
					class="bg-background hover:bg-accent flex h-7 items-center gap-1.5 rounded-full border pr-1.5 pl-2.5 text-xs"
					aria-label="Remove filter label: {label.name}"
					onclick={() => toggleLabel(label.id)}
				>
					<span class="text-muted-foreground">label</span>
					<LabelChip {label} variant="dot" class="max-w-40" />
					<IconX size={13} stroke={2} class="text-muted-foreground" />
				</button>
			{/each}
			{#if filters.state}
				<button
					type="button"
					class="bg-background hover:bg-accent flex h-7 items-center gap-1.5 rounded-full border pr-1.5 pl-2.5 text-xs"
					aria-label="Remove filter state: {filters.state}"
					onclick={() => set('state', '')}
				>
					<span class="text-muted-foreground">state</span>
					<span class="max-w-40 truncate font-medium">{filters.state}</span>
					<IconX size={13} stroke={2} class="text-muted-foreground" />
				</button>
			{/if}
			{#if filters.ready}
				<button
					type="button"
					class="bg-background hover:bg-accent flex h-7 items-center gap-1.5 rounded-full border pr-1.5 pl-2.5 text-xs"
					aria-label="Remove filter: ready only"
					onclick={() => set('ready', '')}
				>
					<span class="font-medium">ready</span>
					<IconX size={13} stroke={2} class="text-muted-foreground" />
				</button>
			{/if}
		</div>
	{/if}

	<!-- Phone: a button that opens the field; desktop: the field itself. -->
	{#if !searchShown}
		<button
			type="button"
			class="border-input hover:bg-accent text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md border sm:hidden"
			aria-label="Search"
			onclick={openSearch}
		>
			<IconSearch size={15} stroke={1.75} />
		</button>
	{/if}
	<form
		class="relative order-5 w-full sm:order-none sm:ml-auto sm:w-56 {searchShown
			? ''
			: 'max-sm:hidden'}"
		onsubmit={(e) => {
			e.preventDefault();
			set('q', search.trim());
		}}
	>
		<IconSearch
			size={14}
			class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"
		/>
		<Input
			bind:ref={searchEl}
			bind:value={search}
			placeholder="Search issues…"
			class="h-9 pr-8 pl-8"
			aria-label="Search issues"
			onblur={() => {
				if (!search.trim() && !filters.q) searchOpen = false;
			}}
		/>
		{#if search || filters.q}
			<button
				type="button"
				class="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
				aria-label="Clear search"
				onclick={() => {
					search = '';
					searchOpen = false;
					if (filters.q) set('q', '');
				}}
			>
				<IconX size={14} stroke={2} />
			</button>
		{/if}
	</form>
</div>
