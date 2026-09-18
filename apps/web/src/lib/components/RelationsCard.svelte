<script lang="ts">
	import type { IssueLinks, IssueListItem, IssueRef, LinkedIssue } from '@tines/shared';
	import { ApiError } from '@tines/shared';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import IconX from '@tabler/icons-svelte/icons/x';
	import { flip } from 'svelte/animate';
	import { slide } from 'svelte/transition';
	import { invalidateAll } from '$app/navigation';
	import { api } from '$lib/api';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import { categoryVar, prefersReducedMotion } from '$lib/format';
	import { isTempLink, TEMP_LINK_PREFIX, type PendingAdd } from '$lib/link-overlay';

	/** One hop of a rejected cycle; refs are absent only for a vanished issue. */
	type PathStep = { issue_id: string; project_name?: string; number?: number; title?: string };
	type FormError = { message: string; path?: PathStep[]; duplicateOf?: IssueRef };

	let {
		issueId,
		links,
		adds = $bindable(),
		removals = $bindable(),
		disabledReason = null,
		onerror
	}: {
		issueId: string;
		/** The merged view (server truth + overlay), owned by the page. */
		links: IssueLinks;
		/** Overlay of in-flight operations, bound to the page so every reload re-merges them. */
		adds: PendingAdd[];
		removals: string[];
		/** When set, every mutating control renders disabled with this as its tooltip. */
		disabledReason?: string | null;
		/** Page-level error banner, for failures the inline form can't own. */
		onerror: (e: unknown) => void;
	} = $props();

	const readOnly = $derived(disabledReason != null);

	const dur = () => (prefersReducedMotion() ? 0 : 180);

	const openBlockers = $derived(
		links.blocked_by.filter((l) => l.effective_state.category !== 'done')
	);
	const isEmpty = $derived(
		!links.duplicate_of &&
			links.blocked_by.length === 0 &&
			links.blocks.length === 0 &&
			links.duplicated_by.length === 0
	);

	// --- removal ---------------------------------------------------------------

	async function removeLink(item: LinkedIssue) {
		// Optimistic: the removal joins the overlay so the row hides in the
		// merged view immediately (and stays hidden through reloads triggered
		// by other in-flight operations), no confirm — links are cheap to
		// re-add and the removal lands in both activity feeds.
		removals = [...removals, item.link_id];
		try {
			await api.removeIssueLink(issueId, item.link_id);
			await invalidateAll();
			// An add of this same row may still be reconciling; drop it too, so
			// clearing the removal can't briefly resurrect the deleted row.
			adds = adds.filter((a) => a.entry.link_id !== item.link_id);
		} catch (e) {
			onerror(e);
		} finally {
			removals = removals.filter((id) => id !== item.link_id);
		}
	}

	// --- add form --------------------------------------------------------------

	let adding = $state(false);
	let kind = $state<'blocked_by' | 'blocks' | 'duplicate_of'>('blocked_by');
	let queryText = $state('');
	let inputEl = $state<HTMLInputElement | null>(null);
	let listOpen = $state(false);
	let highlight = $state(0);
	let formError = $state<FormError | null>(null);
	/** Monotonic per-card counter making each add operation's temp id unique. */
	let addSeq = 0;

	// The picker's pool: fetched once, when the form first opens. Single-user
	// volumes make client-side filtering fine; a server-side `q` is the
	// upgrade path if this ever gets heavy.
	let candidates = $state<IssueListItem[] | null>(null);
	let loadingCandidates = $state(false);

	async function toggleForm() {
		if (adding) {
			adding = false;
			listOpen = false;
			return;
		}
		adding = true;
		listOpen = true;
		formError = null;
		if (candidates === null && !loadingCandidates) {
			loadingCandidates = true;
			try {
				const { items } = await api.listIssues({ limit: 100 });
				// Empty input shows the most recently active issues first.
				candidates = [...items].sort((a, b) => b.last_activity_at - a.last_activity_at);
			} catch (e) {
				onerror(e);
			} finally {
				loadingCandidates = false;
			}
		}
	}

	$effect(() => {
		if (adding && inputEl) inputEl.focus();
	});

	// Adding a duplicate while the form stays open disables that kind; don't
	// leave the select parked on a disabled option.
	$effect(() => {
		if (kind === 'duplicate_of' && links.duplicate_of) kind = 'blocked_by';
	});

	const linkedIds = $derived(
		new Set([
			...links.blocked_by.map((l) => l.issue_id),
			...links.blocks.map((l) => l.issue_id),
			...links.duplicated_by.map((l) => l.issue_id),
			...(links.duplicate_of ? [links.duplicate_of.issue_id] : [])
		])
	);

	const suggestions = $derived.by(() => {
		const term = queryText.trim().toLowerCase();
		const pool = (candidates ?? []).filter((i) => i.id !== issueId && !linkedIds.has(i.id));
		const matched = term
			? pool.filter(
					(i) =>
						`${i.project_name}/${i.number}`.toLowerCase().includes(term) ||
						i.title.toLowerCase().includes(term)
				)
			: pool;
		// Done issues stay available (essential for duplicates of fixed bugs)
		// but sort below the open ones; sort is stable, so recency survives.
		return [...matched]
			.sort(
				(a, b) =>
					Number(a.effective_state.category === 'done') -
					Number(b.effective_state.category === 'done')
			)
			.slice(0, 8);
	});

	// A changed suggestion list restarts the keyboard cursor at the top.
	$effect(() => {
		void suggestions;
		highlight = 0;
	});

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			listOpen = true;
			highlight = Math.min(highlight + 1, suggestions.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			highlight = Math.max(highlight - 1, 0);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const pick = suggestions[highlight];
			if (pick) add(pick);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			if (listOpen) listOpen = false;
			else adding = false;
		}
	}

	function describeError(e: ApiError): FormError {
		const path = e.details?.path;
		if (e.code === 'link_cycle' && Array.isArray(path)) {
			return { message: 'Adding this link would create a cycle:', path: path as PathStep[] };
		}
		const dup = e.details?.duplicate_of;
		if (e.code === 'already_duplicate' && dup) {
			return { message: 'Already a duplicate of', duplicateOf: dup as IssueRef };
		}
		return { message: e.message };
	}

	async function add(target: IssueListItem) {
		formError = null;
		// Optimistic, like pending comments: the row appears dimmed immediately
		// (which also drops the issue from the suggestions, so a second tap
		// can't double-add). It lives in the overlay until its own reload has
		// delivered the server row, so reloads from other in-flight operations
		// can't wipe it in the meantime.
		const requestKind = kind;
		// The temp id doubles as this operation's handle ($state deep-proxies
		// array elements, so identity comparisons on the pushed object won't
		// match — the id is the stable key). Unique per op, so re-adding an
		// issue right after removing it can't cross wires.
		let opLinkId = `${TEMP_LINK_PREFIX}${target.id}-${++addSeq}`;
		adds = [
			...adds,
			{
				group: requestKind === 'duplicate_of' ? 'duplicate_of' : requestKind,
				entry: {
					link_id: opLinkId,
					issue_id: target.id,
					project_name: target.project_name,
					number: target.number,
					title: target.title,
					effective_state: target.effective_state
				}
			}
		];
		queryText = '';
		highlight = 0;
		inputEl?.focus();
		try {
			const created = await api.addIssueLink(issueId, { kind: requestKind, issue_id: target.id });
			// Swap in the real link id (through the reactive array) before the
			// reload lands, so the row is removable right away; the reload then
			// reconciles everything else (badges, readiness, activity).
			const stored = adds.find((a) => a.entry.link_id === opLinkId);
			if (stored) stored.entry.link_id = created.id;
			opLinkId = created.id;
			await invalidateAll();
		} catch (e) {
			// Rejections belong under the form, not in the page banner: the form
			// stays open so the user can correct course.
			if (e instanceof ApiError && (e.status === 422 || e.status === 409)) {
				formError = describeError(e);
			} else {
				onerror(e);
			}
		} finally {
			// The reload (or the failure) has settled this operation; the server
			// truth now carries the row, or the row is gone — either way the
			// overlay entry has served its purpose.
			adds = adds.filter((a) => a.entry.link_id !== opLinkId);
		}
	}

	const issueHref = (projectName: string, number: number) =>
		`/issues/${encodeURIComponent(projectName)}/${number}`;
</script>

<!-- The rows live inline (not in a nested snippet): `animate:` requires the
     element to be the direct child of its keyed `{#each}`. -->
{#snippet group(label: string, items: LinkedIssue[], dimDone: boolean)}
	{#if items.length > 0}
		<div class="mt-3 first:mt-0">
			<p class="text-muted-foreground mb-1 text-[0.6875rem] font-medium tracking-wide uppercase">
				{label}
			</p>
			<ul>
				<!-- Keyed by issue (unique within a group), not link id: a pending
				     row's id swaps temp → real on confirmation, and that must not
				     remount the row. -->
				{#each items as item (item.issue_id)}
					<li
						class="group/row flex items-center gap-1 {isTempLink(item.link_id) ? 'opacity-60' : ''}"
						animate:flip={{ duration: dur() }}
						transition:slide={{ duration: dur() }}
					>
						<a
							href={issueHref(item.project_name, item.number)}
							class="hover:bg-accent/50 flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 transition-[opacity,background-color] duration-200 {dimDone &&
							item.effective_state.category === 'done'
								? 'opacity-55'
								: ''}"
						>
							<span
								class="size-2 shrink-0 rounded-full"
								style="background: {categoryVar(item.effective_state.category)}"
								title={item.effective_state.name}
							></span>
							<span class="shrink-0 font-mono text-xs">{item.project_name}/#{item.number}</span>
							<span class="text-muted-foreground truncate text-xs">{item.title}</span>
						</a>
						<!-- Visible by default; the hover-reveal only applies where a
						     hover actually exists (mouse/trackpad) — touch screens keep
						     the control on screen. -->
						<button
							type="button"
							class="text-muted-foreground hover:text-foreground shrink-0 rounded p-1.5 transition-opacity focus-visible:opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100"
							title={disabledReason ?? 'Remove link'}
							aria-label="Remove link to {item.project_name}/#{item.number}"
							disabled={isTempLink(item.link_id) || readOnly}
							onclick={() => removeLink(item)}
						>
							<IconX size={14} stroke={1.75} />
						</button>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
{/snippet}

<section id="relations" class="rounded-lg border p-4">
	<header class="mb-3 flex items-center justify-between">
		<h2 class="text-sm font-semibold">Relations</h2>
		<Button
			size="sm"
			variant="ghost"
			onclick={toggleForm}
			aria-expanded={adding}
			disabled={readOnly}
			title={disabledReason}
		>
			<IconPlus size={14} /> Add
		</Button>
	</header>

	{#if links.blocked_by.length > 0}
		<!-- The one-glance answer to "why isn't this ready?". -->
		<p class="text-muted-foreground mb-3 flex items-center gap-2 text-xs">
			<span
				class="size-2 shrink-0 rounded-full {openBlockers.length === 0
					? 'bg-emerald-500'
					: 'bg-amber-500'}"
			></span>
			{#if openBlockers.length === 0}
				Ready — all blockers closed
			{:else}
				Not ready — {openBlockers.length} of {links.blocked_by.length} blockers open
			{/if}
		</p>
	{/if}

	<!-- "What's stopping this" first. -->
	{@render group('Blocked by', links.blocked_by, true)}
	{@render group('Blocks', links.blocks, false)}
	{@render group('Duplicate of', links.duplicate_of ? [links.duplicate_of] : [], false)}
	{@render group('Duplicated by', links.duplicated_by, false)}

	{#if isEmpty && !adding}
		<p class="text-muted-foreground text-xs">
			Link issues that block this one, or mark it a duplicate.
		</p>
	{/if}

	{#if adding}
		<div class="mt-3 space-y-2 border-t pt-3" transition:slide={{ duration: dur() }}>
			<!-- An issue has at most one canonical issue, so the option greys out
			     (with the reason) instead of letting the server reject it later. -->
			<Select bind:value={kind} class="h-8 text-xs" aria-label="Link kind">
				<option value="blocked_by">Blocked by</option>
				<option value="blocks">Blocks</option>
				<option value="duplicate_of" disabled={links.duplicate_of !== null}>
					Duplicate of{links.duplicate_of
						? ` (already ${links.duplicate_of.project_name}/#${links.duplicate_of.number})`
						: ''}
				</option>
			</Select>
			<div class="relative">
				<Input
					bind:ref={inputEl}
					bind:value={queryText}
					class="h-8 text-xs"
					placeholder={loadingCandidates ? 'Loading issues…' : 'Search issues…'}
					role="combobox"
					aria-expanded={listOpen}
					aria-label="Issue to link"
					autocomplete="off"
					onfocus={() => (listOpen = true)}
					onblur={() => (listOpen = false)}
					onkeydown={onKeydown}
				/>
				{#if listOpen && suggestions.length > 0}
					<ul
						class="bg-popover text-popover-foreground absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-md border p-1 shadow-md"
					>
						{#each suggestions as suggestion, i (suggestion.id)}
							<li>
								<button
									type="button"
									class="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left {i ===
									highlight
										? 'bg-accent'
										: ''} {suggestion.effective_state.category === 'done' ? 'opacity-55' : ''}"
									onmouseenter={() => (highlight = i)}
									onpointerdown={(e) => e.preventDefault()}
									onclick={() => add(suggestion)}
								>
									<span
										class="size-2 shrink-0 rounded-full"
										style="background: {categoryVar(suggestion.effective_state.category)}"
										title={suggestion.effective_state.name}
									></span>
									<span class="shrink-0 font-mono text-xs">
										{suggestion.project_name}/#{suggestion.number}
									</span>
									<span class="text-muted-foreground truncate text-xs">{suggestion.title}</span>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			{#if formError}
				<p
					class="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-2 py-1.5 text-xs"
					transition:slide={{ duration: dur() }}
				>
					{formError.message}
					{#if formError.path}
						{#each formError.path as step, i (i)}
							{#if i > 0}<span class="opacity-70">→</span>{/if}
							{#if step.project_name && step.number !== undefined}
								<a
									href={issueHref(step.project_name, step.number)}
									class="font-mono underline underline-offset-2"
								>
									{step.project_name}/#{step.number}
								</a>
							{:else}
								<span class="font-mono">{step.issue_id}</span>
							{/if}
						{/each}
					{:else if formError.duplicateOf}
						<a
							href={issueHref(formError.duplicateOf.project_name, formError.duplicateOf.number)}
							class="font-mono underline underline-offset-2"
						>
							{formError.duplicateOf.project_name}/#{formError.duplicateOf.number}
						</a>
						— remove that link first.
					{/if}
				</p>
			{/if}
			<!-- Keyboard hints mean nothing to a touch screen. -->
			<p class="text-muted-foreground hidden text-[0.6875rem] pointer-fine:block">
				↑↓ to choose, Enter to link, Esc to close.
			</p>
		</div>
	{/if}
</section>
