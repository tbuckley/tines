import { Graph, layout as dagreLayout } from '@dagrejs/dagre';
import type { EdgeLabel, GraphLabel, NodeLabel } from '@dagrejs/dagre';
import type { StateCategory } from '@tines/shared';

export interface GraphState {
	id: string;
	name: string;
	category: StateCategory;
}

export interface GraphTransition {
	id?: string;
	name?: string;
	from_state_id: string;
	to_state_id: string;
}

export interface GraphWorkflow {
	states: readonly GraphState[];
	transitions: readonly GraphTransition[];
	initial_state_id: string;
}

export interface Point {
	x: number;
	y: number;
}

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface WorkflowGraphNode extends GraphState, Rect {
	cx: number;
	cy: number;
	isInitial: boolean;
	isDeadEnd: boolean;
}

export interface WorkflowGraphEdge {
	key: string;
	from: string;
	to: string;
	d: string;
	points: Point[];
	backward: boolean;
	label: string | null;
	labelBox: Rect | null;
	lx: number;
	ly: number;
}

export interface WorkflowGraphLayout {
	status: 'ok' | 'empty' | 'error';
	nodes: readonly WorkflowGraphNode[];
	edges: readonly WorkflowGraphEdge[];
	width: number;
	height: number;
	font: number;
}

const settings = {
	full: {
		font: 12.5,
		height: 34,
		minWidth: 72,
		contentAllowance: 40,
		startPad: 24,
		ranksep: 60,
		nodesep: 24,
		edgesep: 16,
		minlen: 1,
		margin: 12
	},
	compact: {
		font: 10.5,
		height: 26,
		minWidth: 54,
		contentAllowance: 30,
		startPad: 18,
		ranksep: 17,
		nodesep: 16,
		edgesep: 10,
		minlen: 2,
		margin: 8
	}
} as const;

const edgeFont = 9.5;
const emptyLayout = (status: 'empty' | 'error', font: number): WorkflowGraphLayout => ({
	status,
	nodes: [],
	edges: [],
	width: 0,
	height: 0,
	font
});

/** Conservative, deterministic SVG text width in graph units. */
export function estimateTextWidth(text: string, fontSize: number): number {
	let em = 0;
	for (const char of text) {
		const code = char.codePointAt(0)!;
		if (code > 0x7f) em += 1.5;
		else if ('MWmw@%&'.includes(char)) em += 1.1;
		else if ("ilI.,'`!:;| ".includes(char)) em += 0.4;
		else if (/[A-Z]/.test(char)) em += 0.9;
		else if (/[a-z0-9]/.test(char)) em += 0.7;
		else em += 0.75;
	}
	return Math.ceil(em * fontSize);
}

function intersectRect(rect: Rect, toward: Point): Point {
	const cx = rect.x + rect.w / 2;
	const cy = rect.y + rect.h / 2;
	const dx = toward.x - cx;
	const dy = toward.y - cy;
	if (dx === 0 && dy === 0) return { x: cx, y: cy };
	const scale = Math.min(
		dx === 0 ? Infinity : rect.w / 2 / Math.abs(dx),
		dy === 0 ? Infinity : rect.h / 2 / Math.abs(dy)
	);
	return { x: cx + dx * scale, y: cy + dy * scale };
}

function dedupePoints(points: readonly Point[]): Point[] {
	return points.filter((point, index) => {
		const previous = points[index - 1];
		return !previous || previous.x !== point.x || previous.y !== point.y;
	});
}

const pathOf = (points: readonly Point[]) =>
	points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');

function transitionKeys(transitions: readonly GraphTransition[]): string[] {
	const seen = new Map<string, number>();
	return transitions.map((transition) => {
		const base = transition.id
			? `id:${JSON.stringify(transition.id)}`
			: `tuple:${JSON.stringify([
					transition.from_state_id,
					transition.to_state_id,
					transition.name ?? ''
				])}`;
		const occurrence = seen.get(base) ?? 0;
		seen.set(base, occurrence + 1);
		return `${base}#${occurrence}`;
	});
}

export function layoutWorkflowGraph(
	workflow: GraphWorkflow,
	options: { compact: boolean }
): WorkflowGraphLayout {
	const config = options.compact ? settings.compact : settings.full;
	if (workflow.states.length === 0) return emptyLayout('empty', config.font);

	try {
		const stateIds = new Set<string>();
		for (const state of workflow.states) {
			if (stateIds.has(state.id)) return emptyLayout('error', config.font);
			stateIds.add(state.id);
		}

		const graph = new Graph<GraphLabel, NodeLabel, EdgeLabel>({ multigraph: true })
			.setGraph({
				rankdir: 'LR',
				ranker: 'network-simplex',
				ranksep: config.ranksep,
				nodesep: config.nodesep,
				edgesep: config.edgesep,
				marginx: 0,
				marginy: 0
			})
			.setDefaultEdgeLabel(() => ({}));

		const graphNameByState = new Map<string, string>();
		workflow.states.forEach((state, index) => {
			const graphName = `n${index}`;
			graphNameByState.set(state.id, graphName);
			const bodyWidth = Math.max(
				config.minWidth,
				estimateTextWidth(state.name, config.font) + config.contentAllowance
			);
			graph.setNode(graphName, {
				width: bodyWidth + (state.id === workflow.initial_state_id ? config.startPad : 0),
				height: config.height
			});
		});

		const keys = transitionKeys(workflow.transitions);
		const validTransitions: Array<{
			transition: GraphTransition;
			key: string;
			graphEdgeName: string;
		}> = [];
		workflow.transitions.forEach((transition, index) => {
			const from = graphNameByState.get(transition.from_state_id);
			const to = graphNameByState.get(transition.to_state_id);
			if (!from || !to) return;
			const label = !options.compact && transition.name ? transition.name : null;
			const graphEdgeName = `e${index}`;
			graph.setEdge(
				from,
				to,
				{
					width: label ? estimateTextWidth(label, edgeFont) + 8 : 0,
					height: label ? 20 : 0,
					minlen: config.minlen,
					labelpos: 'c'
				},
				graphEdgeName
			);
			validTransitions.push({ transition, key: keys[index], graphEdgeName });
		});

		dagreLayout(graph);

		const nodes: WorkflowGraphNode[] = workflow.states.map((state) => {
			const value = graph.node(graphNameByState.get(state.id)!);
			if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new Error('node geometry');
			const isInitial = state.id === workflow.initial_state_id;
			const totalWidth = value.width;
			const bodyWidth = totalWidth - (isInitial ? config.startPad : 0);
			const x = value.x! - totalWidth / 2 + (isInitial ? config.startPad : 0);
			const y = value.y! - config.height / 2;
			return {
				...state,
				x,
				y,
				w: bodyWidth,
				h: config.height,
				cx: x + bodyWidth / 2,
				cy: y + config.height / 2,
				isInitial,
				isDeadEnd:
					state.category !== 'done' &&
					!validTransitions.some(({ transition }) => transition.from_state_id === state.id)
			};
		});
		const nodeById = new Map(nodes.map((node) => [node.id, node]));

		const edges: WorkflowGraphEdge[] = validTransitions.map(
			({ transition, key, graphEdgeName }) => {
				const fromName = graphNameByState.get(transition.from_state_id)!;
				const toName = graphNameByState.get(transition.to_state_id)!;
				const value = graph.edge({ v: fromName, w: toName, name: graphEdgeName });
				if (!value?.points?.length) throw new Error('edge geometry');
				const points = dedupePoints(value.points);
				if (points.length < 2 || points.some((point) => !Number.isFinite(point.x + point.y)))
					throw new Error('edge geometry');
				const source = nodeById.get(transition.from_state_id)!;
				const target = nodeById.get(transition.to_state_id)!;
				if (source.id !== target.id) {
					points[0] = intersectRect(source, points[1]);
					points[points.length - 1] = intersectRect(target, points[points.length - 2]);
				}
				const label = !options.compact && transition.name ? transition.name : null;
				const labelBox =
					label && Number.isFinite(value.x) && Number.isFinite(value.y)
						? {
								x: value.x! - (value.width ?? 0) / 2,
								y: value.y! - (value.height ?? 0) / 2,
								w: value.width ?? 0,
								h: value.height ?? 0
							}
						: null;
				return {
					key,
					from: transition.from_state_id,
					to: transition.to_state_id,
					d: '',
					points,
					backward: target.cx <= source.cx,
					label,
					labelBox,
					lx: labelBox ? labelBox.x + labelBox.w / 2 : 0,
					ly: labelBox ? labelBox.y + labelBox.h / 2 : 0
				};
			}
		);

		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		const include = (rect: Rect, padding = 0) => {
			minX = Math.min(minX, rect.x - padding);
			minY = Math.min(minY, rect.y - padding);
			maxX = Math.max(maxX, rect.x + rect.w + padding);
			maxY = Math.max(maxY, rect.y + rect.h + padding);
		};
		for (const node of nodes) {
			include(node, 5);
			if (node.isInitial)
				include({ x: node.x - config.startPad, y: node.y, w: config.startPad, h: node.h }, 5);
		}
		for (const edge of edges) {
			for (const point of edge.points) include({ x: point.x, y: point.y, w: 0, h: 0 }, 7);
			if (edge.labelBox) include(edge.labelBox, 2);
		}

		const dx = config.margin - minX;
		const dy = config.margin - minY;
		for (const node of nodes) {
			node.x += dx;
			node.y += dy;
			node.cx += dx;
			node.cy += dy;
		}
		for (const edge of edges) {
			const shifted = edge.points.map((point) => ({ x: point.x + dx, y: point.y + dy }));
			edge.points = shifted;
			edge.d = pathOf(shifted);
			edge.lx += dx;
			edge.ly += dy;
			if (edge.labelBox) {
				edge.labelBox.x += dx;
				edge.labelBox.y += dy;
			}
		}

		return {
			status: 'ok',
			nodes,
			edges,
			width: Math.ceil(maxX - minX + config.margin * 2),
			height: Math.ceil(maxY - minY + config.margin * 2),
			font: config.font
		};
	} catch {
		return emptyLayout('error', config.font);
	}
}
