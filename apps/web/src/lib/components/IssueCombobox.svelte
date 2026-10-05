<script lang="ts">
	import { ApiError, type IssueDetail, type IssueListItem, type Project } from '@tines/shared';
	import IconX from '@tabler/icons-svelte/icons/x';
	import { onDestroy, tick, untrack } from 'svelte';
	import { api } from '$lib/api';
	import { Input } from '$lib/components/ui/input/index.js';
	import { categoryVar } from '$lib/format';
	import { fitBelow } from '$lib/popover-fit';
	import {
		findProjectByName,
		issueLabel,
		issueRef,
		mergeIssueOptions,
		parseIssueQuery,
		type IssuePick
	} from '$lib/issue-picker';

	const LIMIT = 8;
	/** Excluded issues still take up rows in a page; fetch that many more, within reason. */
	const MAX_FETCH = 50;
	const DEBOUNCE_MS = 200;

	let {
		projectId,
		homeProjectId,
		includeDone = false,
		includeDuplicates = false,
		exclude = [],
		onpick,
		id,
		label,
		clearLabel = 'Clear issue',
		class: className,
		selected = $bindable<IssuePick | null>(null),
		text = $bindable(''),
		ref = $bindable<HTMLInputElement | null>(null),
		placeholder = 'Search by # or title',
		describedby,
		invalid = false,
		disabled = false
	}: {
		/** Search one project. Without it the search spans every project and `Project/N` is accepted. */
		projectId?: string;
		/** When the search spans projects, the project a bare `#N` is looked up in. */
		homeProjectId?: string;
		/** Offer done issues too (below the open ones). */
		includeDone?: boolean;
		/** Offer issues marked as duplicates too. */
		includeDuplicates?: boolean;
		/** Issue ids never offered. */
		exclude?: string[];
		/**
		 * Act on a pick straight away instead of holding it: the input clears and
		 * stays open for the next one, and `selected` is left alone.
		 */
		onpick?: (issue: IssuePick) => void;
		/** The input's id, for `<label for>`. */
		id?: string;
		/** Accessible name, for an input with no visible `<label>`. */
		label?: string;
		clearLabel?: string;
		/** Extra classes for the input. */
		class?: string;
		selected?: IssuePick | null;
		/** The input's text; free text that was never picked leaves `selected` null. */
		text?: string;
		ref?: HTMLInputElement | null;
		placeholder?: string;
		describedby?: string;
		invalid?: boolean;
		disabled?: boolean;
	} = $props();

	const uid = $props.id();
	const listboxId = `${uid}-listbox`;
	const optionId = (i: number) => `${uid}-option-${i}`;

	let open = $state(false);
	let highlight = $state(0);
	type Found = { exact: IssueDetail | null; items: IssueListItem[] };
	const NONE: Found = { exact: null, items: [] };
	/** The last response, unfiltered: `exclude` can change while the list is open. */
	let found = $state.raw<Found>(NONE);
	const options = $derived(
		mergeIssueOptions(found.exact, found.items, {
			limit: LIMIT,
			includeDone,
			includeDuplicates,
			exclude
		})
	);
	const crossProject = $derived(!projectId);
	let status = $state<'idle' | 'loading' | 'error'>('idle');
	/** The newest issues of one search scope, fetched on its first empty focus. */
	let recent: { scope: string; found: Found } | null = null;
	/** Every project the user can see, fetched once for `Project/N` lookups. */
	let projects: Promise<Project[]> | null = null;
	/** Monotonic: a response for an older request is discarded. */
	let seq = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	onDestroy(() => clearTimeout(timer));

	async function run(load: () => Promise<Found>) {
		const mine = ++seq;
		status = 'loading';
		try {
			const result = await load();
			if (mine !== seq) return;
			found = result;
			highlight = 0;
			status = 'idle';
		} catch {
			if (mine !== seq) return;
			found = NONE;
			status = 'error';
		}
	}

	function list(q?: string) {
		const filters = {
			hide_done: !includeDone,
			hide_duplicates: !includeDuplicates,
			brief: true,
			limit: Math.min(LIMIT + exclude.length, MAX_FETCH),
			q
		};
		return projectId ? api.listProjectIssues(projectId, filters) : api.listIssues(filters);
	}

	async function allProjects() {
		const all: Project[] = [];
		let cursor: string | undefined;
		do {
			// Archived ones too: a named project is searched whatever its state.
			const page = await api.listProjects({ archived: 'all', limit: 100, cursor });
			all.push(...page.items);
			cursor = page.next_cursor ?? undefined;
		} while (cursor);
		return all;
	}

	/** A project's id from the name in `Project/N`, whatever case it was typed in. */
	async function projectIdByName(name: string) {
		if (!projects) {
			const request = allProjects();
			projects = request;
			request.catch(() => {
				if (projects === request) projects = null;
			});
		}
		return findProjectByName(await projects, name)?.id ?? null;
	}

	async function lookup(number: number | null, project: string | null) {
		if (number === null) return null;
		// Inside one project a `Project/N` ref is just text; only a bare number is a ref.
		const inProject = projectId
			? project === null
				? projectId
				: null
			: project === null
				? homeProjectId
				: await projectIdByName(project);
		if (!inProject) return null;
		return api.getIssueByNumber(inProject, number).catch((e: unknown): IssueDetail | null => {
			if (e instanceof ApiError && e.status === 404) return null;
			throw e;
		});
	}

	function showRecent() {
		clearTimeout(timer);
		const scope = projectId ?? '';
		if (recent?.scope === scope) {
			seq++;
			found = recent.found;
			highlight = 0;
			status = 'idle';
			return;
		}
		void run(async () => {
			const { items } = await list();
			recent = { scope, found: { exact: null, items } };
			return recent.found;
		});
	}

	function search(value: string) {
		const { q, number, project } = parseIssueQuery(value);
		void run(async () => {
			const [{ items }, exact] = await Promise.all([list(q), lookup(number, project)]);
			return { exact, items };
		});
	}

	/**
	 * The results on hand belong to the scope they were searched in. When it
	 * changes, drop them (and anything in flight) and search the typed text again.
	 */
	function rescope() {
		clearTimeout(timer);
		seq++;
		found = NONE;
		status = 'idle';
		if (selected) return;
		if (text.trim()) search(text);
		else if (open) showRecent();
	}

	let scope: string | null = null;
	$effect(() => {
		const next = `${projectId ?? ''}\n${homeProjectId ?? ''}`;
		if (scope !== null && scope !== next) untrack(rescope);
		scope = next;
	});

	function onfocus() {
		open = true;
		if (!selected && !text.trim()) showRecent();
	}

	function oninput() {
		selected = null;
		open = true;
		clearTimeout(timer);
		// New text makes any in-flight search stale, even before the debounced one starts.
		seq++;
		if (!text.trim()) return showRecent();
		status = 'loading';
		const value = text;
		timer = setTimeout(() => search(value), DEBOUNCE_MS);
	}

	function pick(option: IssuePick) {
		if (onpick) {
			onpick(option);
			text = '';
			showRecent();
			return;
		}
		selected = option;
		text = issueLabel(option, crossProject);
		open = false;
	}

	function clear() {
		clearTimeout(timer);
		selected = null;
		text = '';
		ref?.focus();
		showRecent();
		open = true;
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (!open) {
				open = true;
				if (!selected && !text.trim()) showRecent();
				return;
			}
			highlight = Math.min(highlight + 1, options.length - 1);
			void revealHighlight();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			highlight = Math.max(highlight - 1, 0);
			void revealHighlight();
		} else if (e.key === 'Enter') {
			// Only intercept when there is something to pick; otherwise the form submits.
			const option = options[highlight];
			if (open && status === 'idle' && option) {
				e.preventDefault();
				pick(option);
			}
		} else if (e.key === 'Escape' && open) {
			e.preventDefault();
			open = false;
		}
	}

	const showList = $derived(
		open && !selected && (status !== 'idle' || options.length > 0 || !!text.trim())
	);

	let listbox = $state<HTMLUListElement | null>(null);
	/**
	 * The list is positioned past the end of its field, which in a dialog can be
	 * past the end of the scrolling body: scroll it into view as it opens and as
	 * its rows arrive.
	 */
	$effect(() => {
		void status;
		void options;
		listbox?.scrollIntoView({ block: 'nearest' });
	});

	/** Keyboard moves only: scrolling under a resting pointer would move the highlight again. */
	async function revealHighlight() {
		await tick();
		document.getElementById(optionId(highlight))?.scrollIntoView({ block: 'nearest' });
	}

	/**
	 * Keeps the list above the phone's bottom bars and the on-screen keyboard, or
	 * inside a dialog's scrolling body; null before measuring.
	 */
	let maxHeight = $state<number | null>(null);
	$effect(() => {
		if (!showList || !ref) return;
		return fitBelow(ref, (px) => (maxHeight = px));
	});
</script>

<div class="relative">
	<Input
		bind:ref
		bind:value={text}
		{id}
		class={['scroll-mt-20 pr-8', className]}
		aria-label={label}
		{placeholder}
		{disabled}
		role="combobox"
		autocomplete="off"
		aria-autocomplete="list"
		aria-expanded={showList}
		aria-controls={listboxId}
		aria-activedescendant={showList && status === 'idle' && options[highlight]
			? optionId(highlight)
			: undefined}
		aria-describedby={describedby}
		aria-invalid={invalid || undefined}
		{onfocus}
		onblur={() => (open = false)}
		{oninput}
		{onkeydown}
	/>
	{#if text}
		<button
			type="button"
			class="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 rounded-sm"
			aria-label={clearLabel}
			{disabled}
			onpointerdown={(e) => e.preventDefault()}
			onclick={clear}><IconX size={16} /></button
		>
	{/if}
	{#if showList}
		<ul
			bind:this={listbox}
			id={listboxId}
			role="listbox"
			class="bg-popover text-popover-foreground absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-md border p-1 shadow-md"
			style:max-height={maxHeight === null ? undefined : `${maxHeight}px`}
		>
			{#if status === 'loading'}
				<li class="text-muted-foreground px-1.5 py-1 text-sm">Searching…</li>
			{:else if status === 'error'}
				<li class="text-muted-foreground px-1.5 py-1 text-sm">Couldn't load issues</li>
			{:else if options.length === 0}
				<li class="text-muted-foreground px-1.5 py-1 text-sm">
					{includeDone ? 'No issues match' : 'No open issues match'}
				</li>
			{:else}
				{#each options as option, i (option.id)}
					<li
						id={optionId(i)}
						role="option"
						aria-selected={i === highlight}
						tabindex="-1"
						class="flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-sm {i ===
						highlight
							? 'bg-accent'
							: ''} {option.effective_state.category === 'done' ? 'opacity-55' : ''}"
						onmouseenter={() => (highlight = i)}
						onpointerdown={(e) => e.preventDefault()}
						onclick={() => pick(option)}
						onkeydown={() => {}}
					>
						{#if includeDone}
							<span
								class="size-2 shrink-0 rounded-full"
								style="background: {categoryVar(option.effective_state.category)}"
								title={option.effective_state.name}
							></span>
						{/if}
						<span class="shrink-0 font-mono text-xs">{issueRef(option, crossProject)}</span>
						<span class="truncate">{option.title}</span>
					</li>
				{/each}
			{/if}
		</ul>
	{/if}
</div>
