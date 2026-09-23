<script lang="ts">
	import { categoryVar, prefersReducedMotion } from '$lib/format';
	import { layoutWorkflowGraph, type GraphWorkflow } from '$lib/workflow-graph-layout';

	let {
		workflow,
		currentStateId = null,
		compact = false,
		fit = true,
		intrinsicScale = 1
	}: {
		workflow: GraphWorkflow;
		/** Highlighted state; changes animate along the traversed edge. */
		currentStateId?: string | null;
		compact?: boolean;
		/** Fit to the container. Disable to fix a full graph at intrinsic size; the caller must contain overflow. */
		fit?: boolean;
		/** Scale intrinsic full-mode dimensions without changing graph geometry. */
		intrinsicScale?: number;
	} = $props();

	// Stable across SSR and hydration; distinct when several graphs share a page.
	const uid = $props.id();
	const layout = $derived(layoutWorkflowGraph(workflow, { compact }));

	// --- transition animation -------------------------------------------------

	// The state shown as current; lags behind `currentStateId` while the
	// travel dot is en route along the traversed edge.
	let displayedStateId = $state<string | null>(null);
	let travel = $state<{ d: string; key: number; edgeKey: string; toId: string } | null>(null);
	let travelSeq = 0;
	let prevId: string | null = null;
	let travelTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		const next = currentStateId;
		const prev = prevId;
		prevId = next;
		if (next === prev) return;
		if (travelTimer) clearTimeout(travelTimer);
		travelTimer = null;
		travelSeq += 1;
		const edge =
			prev && next ? layout.edges.find((e) => e.from === prev && e.to === next) : undefined;
		if (!edge || prefersReducedMotion()) {
			travel = null;
			displayedStateId = next;
			return;
		}
		displayedStateId = prev;
		const seq = travelSeq;
		travel = { d: edge.d, key: seq, edgeKey: edge.key, toId: next! };
		travelTimer = setTimeout(() => {
			if (seq !== travelSeq) return;
			travel = null;
			displayedStateId = next;
			travelTimer = null;
		}, 480);
	});

	$effect(() => () => {
		travelSeq += 1;
		if (travelTimer) clearTimeout(travelTimer);
	});

	const highlightId = $derived(displayedStateId ?? currentStateId);
</script>

{#if layout.nodes.length > 0}
	<svg
		viewBox="0 0 {layout.width} {layout.height}"
		class="h-auto w-full"
		style:max-width={`${!fit && !compact ? layout.width * intrinsicScale : layout.width * (compact ? 1 : 1.15)}px`}
		style:min-width={!fit && !compact ? `${layout.width * intrinsicScale}px` : undefined}
		role="img"
		aria-label="Workflow graph"
	>
		<defs>
			<marker
				id="arrow-{uid}"
				viewBox="0 0 10 10"
				refX="9"
				refY="5"
				markerWidth="6.5"
				markerHeight="6.5"
				orient="auto-start-reverse"
			>
				<path d="M 0 1 L 9 5 L 0 9 z" class="fill-muted-foreground/70" />
			</marker>
			<marker
				id="arrow-active-{uid}"
				viewBox="0 0 10 10"
				refX="9"
				refY="5"
				markerWidth="6.5"
				markerHeight="6.5"
				orient="auto-start-reverse"
			>
				<path d="M 0 1 L 9 5 L 0 9 z" fill="var(--cat-active)" />
			</marker>
		</defs>

		<!-- edges -->
		{#each layout.edges as edge (edge.key)}
			{@const active = travel?.edgeKey === edge.key && highlightId === edge.from}
			<path
				d={edge.d}
				data-graph-transition={edge.key}
				fill="none"
				class={active ? '' : 'stroke-muted-foreground/45'}
				style={active ? 'stroke: var(--cat-active)' : ''}
				stroke-width={active ? 2 : 1.25}
				stroke-dasharray={edge.backward ? '4 3' : undefined}
				stroke-linecap="round"
				stroke-linejoin="round"
				marker-end="url(#{active ? `arrow-active-${uid}` : `arrow-${uid}`})"
			/>
			{#if edge.label}
				<text
					x={edge.lx}
					y={edge.ly}
					data-graph-transition-label={edge.key}
					text-anchor="middle"
					dominant-baseline="central"
					font-size="9.5"
					class="fill-muted-foreground"
					style="paint-order: stroke; stroke: var(--background); stroke-width: 3px; stroke-linejoin: round"
				>
					{edge.label}
				</text>
			{/if}
		{/each}

		<!-- nodes -->
		{#each layout.nodes as node (node.id)}
			{@const isCurrent = node.id === highlightId}
			<g>
				{#if node.isInitial}
					<!-- start marker: dot + short arrow into the initial state -->
					<circle
						cx={node.x - (compact ? 15 : 20)}
						cy={node.cy}
						r={compact ? 2.5 : 3}
						class="fill-muted-foreground/70"
					/>
					<line
						x1={node.x - (compact ? 12 : 16)}
						y1={node.cy}
						x2={node.x - 3}
						y2={node.cy}
						class="stroke-muted-foreground/70"
						stroke-width="1.25"
						marker-end="url(#arrow-{uid})"
					/>
				{/if}
				{#if isCurrent}
					<rect
						x={node.x - 3}
						y={node.y - 3}
						width={node.w + 6}
						height={node.h + 6}
						rx={(compact ? 7 : 9) + 3}
						fill="none"
						stroke={categoryVar(node.category)}
						stroke-opacity="0.35"
						stroke-width="4"
					/>
				{/if}
				<rect
					x={node.x}
					y={node.y}
					data-graph-state={node.id}
					width={node.w}
					height={node.h}
					rx={compact ? 7 : 9}
					style="fill: color-mix(in oklab, {categoryVar(node.category)} {isCurrent
						? 16
						: 9}%, var(--background)); stroke: {categoryVar(node.category)}"
					stroke-width={isCurrent ? 2 : 1.25}
					stroke-dasharray={node.isDeadEnd ? '5 3' : undefined}
				/>
				<circle
					cx={node.x + (compact ? 11 : 14)}
					cy={node.cy}
					r={compact ? 2.5 : 3}
					fill={categoryVar(node.category)}
				/>
				<text
					x={node.x + (compact ? 19 : 24)}
					y={node.cy}
					data-graph-state-label={node.id}
					dominant-baseline="central"
					font-size={layout.font}
					font-weight={isCurrent ? 600 : 500}
					class="fill-foreground"
				>
					{node.name}
				</text>
			</g>
		{/each}

		<!-- travel dot: rides the traversed edge on a transition -->
		{#if travel}
			{#key travel.key}
				<circle r={compact ? 4 : 5} fill="var(--cat-active)" opacity="0.9">
					<animateMotion
						dur="0.45s"
						path={travel.d}
						fill="freeze"
						calcMode="spline"
						keySplines="0.4 0 0.2 1"
						keyTimes="0;1"
						keyPoints="0;1"
					/>
				</circle>
			{/key}
		{/if}
	</svg>
{:else if layout.status === 'empty'}
	<p class="text-muted-foreground text-sm">No states yet.</p>
{:else}
	<p class="text-muted-foreground text-sm">Unable to display workflow graph.</p>
{/if}
