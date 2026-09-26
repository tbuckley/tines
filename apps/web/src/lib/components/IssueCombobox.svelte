<script lang="ts">
	import { ApiError, type IssueDetail } from '@tines/shared';
	import IconX from '@tabler/icons-svelte/icons/x';
	import { onDestroy } from 'svelte';
	import { api } from '$lib/api';
	import { Input } from '$lib/components/ui/input/index.js';
	import {
		issueLabel,
		mergeIssueOptions,
		parseIssueQuery,
		type IssuePick
	} from '$lib/issue-picker';

	const LIMIT = 8;
	const DEBOUNCE_MS = 200;

	let {
		projectId,
		id,
		selected = $bindable<IssuePick | null>(null),
		text = $bindable(''),
		ref = $bindable<HTMLInputElement | null>(null),
		placeholder = 'Search by # or title',
		describedby,
		invalid = false,
		disabled = false
	}: {
		projectId: string;
		/** The input's id, for `<label for>`. */
		id: string;
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
	let options = $state<IssuePick[]>([]);
	let status = $state<'idle' | 'loading' | 'error'>('idle');
	/** The newest open issues, fetched once on the first empty focus. */
	let recent: IssuePick[] | null = null;
	/** Monotonic: a response for an older request is discarded. */
	let seq = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	onDestroy(() => clearTimeout(timer));

	async function run(load: () => Promise<IssuePick[]>) {
		const mine = ++seq;
		status = 'loading';
		try {
			const result = await load();
			if (mine !== seq) return;
			options = result;
			highlight = 0;
			status = 'idle';
		} catch {
			if (mine !== seq) return;
			options = [];
			status = 'error';
		}
	}

	function showRecent() {
		clearTimeout(timer);
		if (recent) {
			seq++;
			options = recent;
			highlight = 0;
			status = 'idle';
			return;
		}
		void run(async () => {
			const { items } = await api.listProjectIssues(projectId, {
				hide_done: true,
				brief: true,
				limit: LIMIT
			});
			recent = mergeIssueOptions(null, items, LIMIT);
			return recent;
		});
	}

	function search(value: string) {
		const { q, number } = parseIssueQuery(value);
		void run(async () => {
			const [list, exact] = await Promise.all([
				api.listProjectIssues(projectId, { hide_done: true, brief: true, limit: LIMIT, q }),
				number === null
					? Promise.resolve(null)
					: api.getIssueByNumber(projectId, number).catch((e: unknown): IssueDetail | null => {
							if (e instanceof ApiError && e.status === 404) return null;
							throw e;
						})
			]);
			return mergeIssueOptions(exact, list.items, LIMIT);
		});
	}

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
		selected = option;
		text = issueLabel(option);
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
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			highlight = Math.max(highlight - 1, 0);
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
</script>

<div class="relative">
	<Input
		bind:ref
		bind:value={text}
		{id}
		class="pr-8"
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
			aria-label="Clear landing issue"
			{disabled}
			onpointerdown={(e) => e.preventDefault()}
			onclick={clear}><IconX size={16} /></button
		>
	{/if}
	{#if showList}
		<ul
			id={listboxId}
			role="listbox"
			class="bg-popover text-popover-foreground absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-md border p-1 shadow-md"
		>
			{#if status === 'loading'}
				<li class="text-muted-foreground px-1.5 py-1 text-sm">Searching…</li>
			{:else if status === 'error'}
				<li class="text-muted-foreground px-1.5 py-1 text-sm">Couldn't load issues</li>
			{:else if options.length === 0}
				<li class="text-muted-foreground px-1.5 py-1 text-sm">No open issues match</li>
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
							: ''}"
						onmouseenter={() => (highlight = i)}
						onpointerdown={(e) => e.preventDefault()}
						onclick={() => pick(option)}
						onkeydown={() => {}}
					>
						<span class="shrink-0 font-mono text-xs">#{option.number}</span>
						<span class="truncate">{option.title}</span>
					</li>
				{/each}
			{/if}
		</ul>
	{/if}
</div>
