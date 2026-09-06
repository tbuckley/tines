<script lang="ts">
	import type { AllowedTransition, ArtifactRequirementCheck, WorkflowState } from '@tines/shared';
	import IconDots from '@tabler/icons-svelte/icons/dots';
	import StateGlyph from '$lib/components/StateGlyph.svelte';
	import { categoryVar } from '$lib/format';
	import { fitDirect } from '$lib/transitions';

	/**
	 * The phone's decide-while-reading bar, pinned above the tab bar: the
	 * state (a button opening the State sheet with every transition), then
	 * whichever transitions fit whole — at most two, in the list's order — and
	 * a "more" button whenever any are hidden or the state is terminal. Names
	 * are never truncated; a transition that does not fit lives in the sheet.
	 *
	 * The first slot is the list's head, which `planTransitions` makes the
	 * workflow's expected next step (muted when it is blocked, and then a tap
	 * opens the sheet at its requirement). Because that move is the reason to
	 * come here, the state chip yields width down to `STATE_MIN` so it fits —
	 * the header's badge carries the state's full name anyway. A second button
	 * never costs the chip its name.
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
		/** The one filled button: the workflow's expected next step, when it is enabled. */
		primaryId: string | null;
		disabled?: boolean;
		onmove: (t: AllowedTransition) => void;
		onopen: () => void;
	} = $props();

	const MAX_DIRECT = 2;
	const GAP = 8;
	/** 4.5 rem: glyph 16 + gap 6 + padding 12 + ~38 px of the state's name. */
	const STATE_MIN = 72;

	let barEl: HTMLElement | undefined = $state();
	let measureEl: HTMLElement | undefined = $state();
	let stateMeasureEl: HTMLElement | undefined = $state();
	let widths: number[] = $state([]);
	let moreWidth = $state(0);
	let barWidth = $state(0);
	let stateWidth = $state(0);

	const visibleCount = $derived.by(() => {
		if (widths.length !== transitions.length || barWidth === 0) {
			return Math.min(1, transitions.length);
		}
		return fitDirect({
			widths,
			moreWidth,
			barWidth,
			stateWidth,
			stateMin: STATE_MIN,
			gap: GAP,
			max: MAX_DIRECT
		});
	});
	const hidden = $derived(transitions.length - visibleCount);

	const remeasure = () => {
		if (!barEl || !measureEl || !stateMeasureEl) return;
		const buttons = [...measureEl.children] as HTMLElement[];
		const all = buttons.map((el) => el.getBoundingClientRect().width);
		// The row is [state chip, ...transitions, more].
		moreWidth = all.pop() ?? 0;
		all.shift();
		widths = all;
		// The content box: `clientWidth` includes the bar's own `px-3`, and with
		// a chip that can no longer shrink to nothing those 24 px are the
		// difference between a button that fits and one that spills out.
		const pad = getComputedStyle(barEl);
		barWidth = barEl.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
		// The chip's *natural* width: it is `min-w-[4.5rem] shrink`, so a chip
		// already squeezed by a long first button measures at the floor and the
		// arithmetic would hold its own outcome true.
		stateWidth = stateMeasureEl?.getBoundingClientRect().width ?? 0;
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
			type="button"
			class="flex h-9 min-w-[4.5rem] shrink items-center gap-1.5 rounded-md px-1.5 text-sm font-medium"
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
		<!-- Out of flow and invisible, purely to be measured: the state chip at
		     its natural width, every transition button, then the "more" button. -->
		<div
			bind:this={measureEl}
			aria-hidden="true"
			class="pointer-events-none invisible absolute top-0 left-0 flex items-center gap-2"
		>
			<span
				bind:this={stateMeasureEl}
				class="flex h-9 items-center gap-1.5 px-1.5 text-sm font-medium whitespace-nowrap"
			>
				<StateGlyph category={current.category} />{current.name}
			</span>
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
