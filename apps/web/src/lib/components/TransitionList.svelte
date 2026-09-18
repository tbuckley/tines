<script lang="ts">
	import type { AllowedTransition, ArtifactRequirementCheck } from '@tines/shared';
	import IconArrowRight from '@tabler/icons-svelte/icons/arrow-right';
	import IconBan from '@tabler/icons-svelte/icons/ban';
	import IconCheck from '@tabler/icons-svelte/icons/check';
	import { flip } from 'svelte/animate';
	import { fade } from 'svelte/transition';
	import { Button } from '$lib/components/ui/button/index.js';
	import { prefersReducedMotion, relativeTime } from '$lib/format';

	/**
	 * The transitions out of the current state, one full-width button each
	 * with its target right-aligned, and each requirement line directly under
	 * its own button (Tines/128). Shared by the desktop State card and the
	 * phone's State sheet, so the two never drift.
	 */
	let {
		transitions,
		unmetFor,
		disabled = false,
		disabledReason = null,
		stateEnteredAt,
		onmove
	}: {
		/**
		 * Already ordered by `planTransitions`: forward moves first (enabled, then
		 * blocked, whose requirement line is the next action), then steps back,
		 * then the escape lane.
		 */
		transitions: AllowedTransition[];
		unmetFor: (t: AllowedTransition) => ArtifactRequirementCheck[];
		disabled?: boolean;
		/** Why the buttons are disabled, as their tooltip (archived project). */
		disabledReason?: string | null;
		stateEnteredAt: number;
		onmove: (t: AllowedTransition) => void;
	} = $props();

	const dur = () => (prefersReducedMotion() ? 0 : 180);
	// Rendered in two places at once (card and sheet): ids must not collide.
	const uid = $props.id();
</script>

{#if transitions.length > 0}
	<div class="flex flex-col gap-2">
		{#each transitions as transition (transition.transition_id)}
			{@const unmet = unmetFor(transition)}
			{@const reqId = `transition-req-${uid}-${transition.transition_id}`}
			<div class="min-w-0" animate:flip={{ duration: dur() }}>
				<!-- Reason lines are SIBLINGS of the button, never children: the
				     button's accessible name stays "<name> → <state>". -->
				<Button
					size="sm"
					variant="outline"
					class="w-full justify-between"
					disabled={disabled || unmet.length > 0}
					aria-describedby={transition.requires?.length ? reqId : undefined}
					onclick={() => onmove(transition)}
					title={disabledReason ?? transition.name}
				>
					<span class="min-w-0 truncate text-left">{transition.name}</span>
					<span
						class="text-muted-foreground inline-flex shrink-0 items-center gap-1 text-xs font-normal"
					>
						<IconArrowRight size={12} />
						{transition.to_state.name}
					</span>
				</Button>
				{#if transition.requires?.length}
					<ul id={reqId} class="mt-1 space-y-1 px-1">
						{#each transition.requires as r (r.artifact)}
							<li
								class="flex items-start gap-1.5 text-xs {r.status === 'satisfied'
									? 'text-muted-foreground'
									: 'text-amber-700 dark:text-amber-400'}"
							>
								{#if r.status === 'satisfied'}
									<IconCheck size={13} class="mt-0.5 shrink-0" />
									<span class="min-w-0">
										<span class="font-mono">{r.artifact}</span> is fresh (v{r.current_version
											?.version}).
									</span>
								{:else}
									<IconBan size={13} class="mt-0.5 shrink-0" />
									<span class="min-w-0">
										{#if r.status === 'missing'}
											Needs artifact <span class="font-mono">{r.artifact}</span> — attach it in
											<a href="#artifacts" class="underline">Artifacts</a>.
										{:else if r.status === 'stale'}
											<span class="font-mono">{r.artifact}</span> is stale — this state began
											{relativeTime(stateEnteredAt)}; attach a new version or reaffirm it.
										{:else if r.type !== undefined && r.current_type !== r.type}
											<span class="font-mono">{r.artifact}</span> must be a {r.type} artifact{#if r.content_type}{' '}
												({r.content_type}){/if} — the attached one is {r.current_type}.
										{:else}
											<!-- Only the content type differs; the API doesn't report the
											     attached version's own content type, so don't name it. -->
											<span class="font-mono">{r.artifact}</span> must be
											{r.content_type} — the attached {r.current_type} isn't.
										{/if}
										{#if r.description}
											<span
												class="text-muted-foreground mt-0.5 line-clamp-2 italic"
												title={r.description}>{r.description}</span
											>
										{/if}
									</span>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/each}
	</div>
{:else}
	<p class="text-muted-foreground text-xs" transition:fade={{ duration: dur() }}>
		No outgoing transitions — this state is terminal.
	</p>
{/if}
