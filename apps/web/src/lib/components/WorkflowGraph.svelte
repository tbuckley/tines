<script lang="ts">
	import type { StateCategory } from '@tines/shared';
	import { categoryVar, prefersReducedMotion } from '$lib/format';

	interface GraphState {
		id: string;
		name: string;
		category: StateCategory;
	}
	interface GraphTransition {
		/** Action name, rendered as an edge label (elided when compact). */
		name?: string;
		from_state_id: string;
		to_state_id: string;
	}
	interface GraphWorkflow {
		states: GraphState[];
		transitions: GraphTransition[];
		initial_state_id: string;
	}

	let {
		workflow,
		currentStateId = null,
		compact = false,
		fit = true
	}: {
		workflow: GraphWorkflow;
		/** Highlighted state; changes animate along the traversed edge. */
		currentStateId?: string | null;
		compact?: boolean;
		/** Fit to the container. Disable to fix a full graph at intrinsic size; the caller must contain overflow. */
		fit?: boolean;
	} = $props();

	// Unique per instance so several graphs on a page don't share markers.
	const uid = Math.random().toString(36).slice(2, 8);

	// --- auto-layout: simple layered (left→right) placement ------------------

	interface Node extends GraphState {
		x: number;
		y: number;
		w: number;
		h: number;
		cx: number;
		cy: number;
		isInitial: boolean;
		isDeadEnd: boolean;
	}
	interface Edge {
		key: string;
		from: string;
		to: string;
		d: string;
		backward: boolean;
		label: string | null;
		lx: number;
		ly: number;
	}

	const layout = $derived.by(() => {
		const M = compact ? 8 : 12; // outer margin
		const START_PAD = compact ? 18 : 24; // room for the initial-state marker
		const { states, transitions, initial_state_id } = workflow;
		if (states.length === 0) {
			return { nodes: [] as Node[], edges: [] as Edge[], width: 0, height: 0 };
		}
		const H = compact ? 26 : 34;
		const charW = compact ? 6.3 : 7.3;
		const font = compact ? 10.5 : 12.5;
		// Full mode renders action names on the edges: the column gap must
		// fit the longest label so it doesn't run into neighboring nodes.
		const maxLabel = compact ? 0 : Math.max(0, ...transitions.map((t) => t.name?.length ?? 0));
		const gapX = compact ? 34 : Math.max(60, maxLabel * 5.2 + 20);
		const gapY = compact ? 14 : 22;

		const out = new Map<string, string[]>();
		for (const t of transitions) {
			out.set(t.from_state_id, [...(out.get(t.from_state_id) ?? []), t.to_state_id]);
		}

		// Rank = BFS depth from the initial state; unreachable states trail.
		const rank = new Map<string, number>();
		if (states.some((s) => s.id === initial_state_id)) {
			rank.set(initial_state_id, 0);
			const queue = [initial_state_id];
			while (queue.length) {
				const cur = queue.shift()!;
				for (const next of out.get(cur) ?? []) {
					if (!rank.has(next) && states.some((s) => s.id === next)) {
						rank.set(next, rank.get(cur)! + 1);
						queue.push(next);
					}
				}
			}
		}
		const maxReached = Math.max(0, ...rank.values());
		for (const s of states) if (!rank.has(s.id)) rank.set(s.id, maxReached + 1);

		// Group into columns preserving state order.
		const columns = new Map<number, GraphState[]>();
		for (const s of states) {
			const r = rank.get(s.id)!;
			columns.set(r, [...(columns.get(r) ?? []), s]);
		}
		const ranks = [...columns.keys()].sort((a, b) => a - b);

		const widthOf = (s: GraphState) =>
			Math.max(compact ? 54 : 72, s.name.length * charW + (compact ? 30 : 40));
		const colWidths = ranks.map((r) => Math.max(...columns.get(r)!.map(widthOf)));
		const colHeights = ranks.map((r) => {
			const n = columns.get(r)!.length;
			return n * H + (n - 1) * gapY;
		});
		const maxColHeight = Math.max(...colHeights);

		const nodes: Node[] = [];
		let x = M + START_PAD;
		ranks.forEach((r, i) => {
			const col = columns.get(r)!;
			let y = M + (maxColHeight - colHeights[i]) / 2;
			for (const s of col) {
				const w = widthOf(s);
				nodes.push({
					...s,
					x: x + (colWidths[i] - w) / 2,
					y,
					w,
					h: H,
					cx: x + colWidths[i] / 2,
					cy: y + H / 2,
					isInitial: s.id === initial_state_id,
					isDeadEnd: s.category !== 'done' && !(out.get(s.id)?.length ?? 0)
				});
				y += H + gapY;
			}
			x += colWidths[i] + gapX;
		});
		const nodeById = new Map(nodes.map((n) => [n.id, n]));

		const edges: Edge[] = [];
		let backIndex = 0;
		const bottom = M + maxColHeight;
		for (const t of transitions) {
			const a = nodeById.get(t.from_state_id);
			const b = nodeById.get(t.to_state_id);
			if (!a || !b) continue;
			const key = `${t.from_state_id}→${t.name}`;
			const label = !compact && t.name ? t.name : null;
			if (rank.get(a.id)! < rank.get(b.id)!) {
				// Forward: right edge of source to left edge of target.
				const x1 = a.x + a.w;
				const y1 = a.cy;
				const x2 = b.x;
				const y2 = b.cy;
				const bend = Math.max(18, (x2 - x1) * 0.45);
				edges.push({
					key,
					from: a.id,
					to: b.id,
					d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
					backward: false,
					label,
					// Curve midpoint (cubic at t=0.5), nudged above the line.
					lx: (x1 + x2) / 2,
					ly: (y1 + y2) / 2 - 6
				});
			} else {
				// Backward / same-rank: route beneath the graph.
				const depth = bottom + (compact ? 14 : 20) + backIndex * (compact ? 12 : 16);
				backIndex += 1;
				const x1 = a.cx;
				const y1 = a.y + a.h;
				const x2 = b.cx;
				const y2 = b.y + b.h;
				edges.push({
					key,
					from: a.id,
					to: b.id,
					d: `M ${x1} ${y1} C ${x1} ${depth}, ${x2} ${depth}, ${x2} ${y2 + 4}`,
					backward: true,
					label,
					lx: (x1 + x2) / 2,
					ly: (y1 + 6 * depth + y2 + 4) / 8 - 5
				});
			}
		}

		const width = x - gapX + M;
		const height =
			bottom +
			(backIndex > 0 ? (compact ? 16 : 24) + (backIndex - 1) * (compact ? 12 : 16) : 0) +
			M;
		return { nodes, edges, width, height, font };
	});

	// --- transition animation -------------------------------------------------

	// The state shown as current; lags behind `currentStateId` while the
	// travel dot is en route along the traversed edge.
	let displayedStateId = $state<string | null>(null);
	let travel = $state<{ d: string; key: number; toId: string } | null>(null);
	let travelSeq = 0;
	let prevId: string | null = null;

	$effect(() => {
		const next = currentStateId;
		const prev = prevId;
		prevId = next;
		if (next === prev) return;
		const edge =
			prev && next ? layout.edges.find((e) => e.from === prev && e.to === next) : undefined;
		if (!edge || prefersReducedMotion()) {
			travel = null;
			displayedStateId = next;
			return;
		}
		displayedStateId = prev;
		const seq = ++travelSeq;
		travel = { d: edge.d, key: seq, toId: next! };
		setTimeout(() => {
			if (seq !== travelSeq) return;
			travel = null;
			displayedStateId = next;
		}, 480);
	});

	const highlightId = $derived(displayedStateId ?? currentStateId);
</script>

{#if layout.nodes.length > 0}
	<svg
		viewBox="0 0 {layout.width} {layout.height}"
		class="h-auto w-full"
		style:max-width={`${!fit && !compact ? layout.width : layout.width * (compact ? 1 : 1.15)}px`}
		style:min-width={!fit && !compact ? `${layout.width}px` : undefined}
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
			{@const active = travel !== null && travel.toId === edge.to && highlightId === edge.from}
			<path
				d={edge.d}
				fill="none"
				class={active ? '' : 'stroke-muted-foreground/45'}
				style={active ? 'stroke: var(--cat-active)' : ''}
				stroke-width={active ? 2 : 1.25}
				stroke-dasharray={edge.backward ? '4 3' : undefined}
				marker-end="url(#{active ? `arrow-active-${uid}` : `arrow-${uid}`})"
			/>
			{#if edge.label}
				<text
					x={edge.lx}
					y={edge.ly}
					text-anchor="middle"
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
{:else}
	<p class="text-muted-foreground text-sm">No states yet.</p>
{/if}
