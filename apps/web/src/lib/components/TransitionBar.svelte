<script lang="ts">
	import type { AllowedTransition, ArtifactRequirementCheck, WorkflowState } from '@tines/shared';
	import IconDots from '@tabler/icons-svelte/icons/dots';
	import StateGlyph from '$lib/components/StateGlyph.svelte';
	import { categoryVar } from '$lib/format';

	/**
	 * The phone's decide-while-reading bar, pinned above the tab bar: the
	 * state (a button opening the State sheet with every transition), then
	 * whichever transitions fit whole — at most two, in the list's order — and
	 * a "more" button whenever any are hidden or the state is terminal. Names
	 * are never truncated; a transition that does not fit lives in the sheet.
	 *
	 * Fit is measured against an invisible copy of every button, so the
	 * decision cannot feed back into itself. Before measurement (server render)
	 * one button shows.
	 */
	let {
		current,
		transitions,
		unmetFor,
		primaryId,
		disabled = false,
		onmove,
		onopen
	}: {
		current: WorkflowState;
		transitions: AllowedTransition[];
		unmetFor: (t: AllowedTransition) => ArtifactRequirementCheck[];
		/** The one filled button: the first enabled forward move, if any. */
		primaryId: string | null;
		disabled?: boolean;
		onmove: (t: AllowedTransition) => void;
		onopen: () => void;
	} = $props();

	const MAX_DIRECT = 2;
	const GAP = 8;

	let barEl: HTMLElement | undefined = $state();
	let measureEl: HTMLElement | undefined = $state();
	let stateEl: HTMLElement | undefined = $state();
	let widths: number[] = $state([]);
	let moreWidth = $state(0);
	let available = $state(0);

	const visibleCount = $derived.by(() => {
		if (widths.length !== transitions.length || available === 0) {
			return Math.min(1, transitions.length);
		}
		let used = 0;
		let count = 0;
		for (let i = 0; i < Math.min(MAX_DIRECT, transitions.length); i++) {
			const next = used + (i === 0 ? 0 : GAP) + widths[i];
			// Room for the "more" button too whenever this one would leave some hidden.
			const needsMore = i < transitions.length - 1;
			if (next + (needsMore ? GAP + moreWidth : 0) > available) break;
			used = next;
			count = i + 1;
		}
		return count;
	});
	const hidden = $derived(transitions.length - visibleCount);

	const remeasure = () => {
		if (!barEl || !measureEl || !stateEl) return;
		const buttons = [...measureEl.children] as HTMLElement[];
		const all = buttons.map((el) => el.getBoundingClientRect().width);
		// The measurement row ends with the "more" button.
		moreWidth = all.pop() ?? 0;
		widths = all;
		available = barEl.clientWidth - stateEl.getBoundingClientRect().width - GAP;
	};

	$effect(() => {
		transitions;
		if (!barEl) return;
		remeasure();
		const observer = new ResizeObserver(remeasure);
		observer.observe(barEl);
		return () => observer.disconnect();
	});

	const buttonClass = (t: AllowedTransition, blocked: boolean) =>
		t.transition_id === primaryId && !blocked
			? 'bg-primary text-primary-foreground border-primary'
			: blocked
				? 'border-input text-muted-foreground opacity-60'
				: 'border-input bg-background hover:bg-accent';
</script>

<!-- Inside <main>, whose view-transition-name makes it a stacking context, so
     a dialog (portaled to <body>) still covers the bar. -->
<div
	class="bg-background/95 fixed inset-x-0 z-30 border-t backdrop-blur sm:hidden"
	style="bottom: calc(4rem + env(safe-area-inset-bottom, 0px))"
	data-testid="transition-bar"
>
	<div bind:this={barEl} class="relative flex h-14 items-center gap-2 px-3">
		<button
			bind:this={stateEl}
			type="button"
			class="flex h-9 min-w-0 shrink items-center gap-1.5 rounded-md px-1.5 text-sm font-medium"
			style:color={categoryVar(current.category)}
			aria-label="State: {current.name}. Show all transitions"
			onclick={onopen}
		>
			<StateGlyph category={current.category} />
			<span class="truncate">{current.name}</span>
		</button>
		<div class="ml-auto flex items-center gap-2">
			{#each transitions.slice(0, visibleCount) as t (t.transition_id)}
				{@const blocked = unmetFor(t).length > 0}
				<!-- A blocked move stays visible but opens the sheet, where its
				     requirement lines explain what is missing. -->
				<button
					type="button"
					class="h-9 rounded-md border px-3 text-sm font-medium whitespace-nowrap disabled:opacity-60 {buttonClass(
						t,
						blocked
					)}"
					aria-disabled={blocked || undefined}
					{disabled}
					title={t.name}
					onclick={() => (blocked ? onopen() : onmove(t))}
				>
					{t.name}
				</button>
			{/each}
			{#if hidden > 0 || transitions.length === 0}
				<button
					type="button"
					class="border-input hover:bg-accent flex h-9 items-center gap-1 rounded-md border px-2 text-sm"
					aria-label={hidden > 0 ? `${hidden} more transitions` : 'Move directly'}
					onclick={onopen}
				>
					<IconDots size={16} stroke={2} />
					{#if hidden > 0}<span class="text-xs">+{hidden}</span>{/if}
				</button>
			{/if}
		</div>
		<!-- Out of flow and invisible: every button at natural width, plus the
		     "more" button, purely to be measured. -->
		<div
			bind:this={measureEl}
			aria-hidden="true"
			class="pointer-events-none invisible absolute top-0 left-0 flex items-center gap-2"
		>
			{#each transitions as t (t.transition_id)}
				<span class="h-9 rounded-md border px-3 text-sm font-medium whitespace-nowrap"
					>{t.name}</span
				>
			{/each}
			<span class="flex h-9 items-center gap-1 rounded-md border px-2 text-sm">
				<IconDots size={16} stroke={2} /><span class="text-xs">+{transitions.length}</span>
			</span>
		</div>
	</div>
</div>
