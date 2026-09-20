import { describe, expect, it } from 'vitest';
import {
	estimateTextWidth,
	layoutWorkflowGraph,
	type GraphWorkflow,
	type Rect,
	type WorkflowGraphLayout
} from './workflow-graph-layout';

const state = (id: string, name = id, category: 'backlog' | 'active' | 'done' = 'active') => ({
	id,
	name,
	category
});

const intersects = (a: Rect, b: Rect, epsilon = 1e-6) =>
	Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > epsilon &&
	Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > epsilon;

function expectInside(layout: WorkflowGraphLayout, rect: Rect, padding: number, label: string) {
	expect(rect.x - padding, `${label} left`).toBeGreaterThanOrEqual(0);
	expect(rect.y - padding, `${label} top`).toBeGreaterThanOrEqual(0);
	expect(rect.x + rect.w + padding, `${label} right`).toBeLessThanOrEqual(layout.width);
	expect(rect.y + rect.h + padding, `${label} bottom`).toBeLessThanOrEqual(layout.height);
}

function expectUsable(layout: WorkflowGraphLayout, edgeCount: number, compact: boolean) {
	expect(layout.status).toBe('ok');
	expect(layout.width).toBeGreaterThan(0);
	expect(layout.height).toBeGreaterThan(0);
	expect(layout.edges).toHaveLength(edgeCount);
	for (const node of layout.nodes) {
		expect([node.x, node.y, node.w, node.h, node.cx, node.cy].every(Number.isFinite)).toBe(true);
		expectInside(layout, node, 5, `state ${node.id} halo`);
		if (node.isInitial)
			expectInside(
				layout,
				{ x: node.x - (compact ? 18 : 24), y: node.y, w: compact ? 18 : 24, h: node.h },
				5,
				`state ${node.id} initial marker`
			);
	}
	for (const edge of layout.edges) {
		expect(edge.d).toMatch(/^M .* L /);
		expect(edge.points.length).toBeGreaterThanOrEqual(2);
		expect(edge.points.flatMap(({ x, y }) => [x, y]).every(Number.isFinite)).toBe(true);
		for (const [index, point] of edge.points.entries())
			expectInside(layout, { ...point, w: 0, h: 0 }, 7, `edge ${edge.key} point ${index}`);
		if (edge.labelBox) expectInside(layout, edge.labelBox, 2, `edge ${edge.key} label`);
	}
}

function expectLabelsClear(layout: WorkflowGraphLayout) {
	const boxes = layout.edges.flatMap((edge) => (edge.labelBox ? [edge.labelBox] : []));
	for (let index = 0; index < boxes.length; index += 1) {
		for (let other = index + 1; other < boxes.length; other += 1)
			expect(intersects(boxes[index], boxes[other])).toBe(false);
		for (const node of layout.nodes) expect(intersects(boxes[index], node)).toBe(false);
	}
}

describe('layoutWorkflowGraph', () => {
	it('handles empty and isolated workflows without mutating the input', () => {
		const empty = { states: [], transitions: [], initial_state_id: '' } satisfies GraphWorkflow;
		expect(layoutWorkflowGraph(empty, { compact: false }).status).toBe('empty');

		const workflow = Object.freeze({
			states: Object.freeze([Object.freeze(state('only', 'Only state', 'backlog'))]),
			transitions: Object.freeze([]),
			initial_state_id: 'only'
		});
		const before = JSON.stringify(workflow);
		const result = layoutWorkflowGraph(workflow, { compact: false });
		expectUsable(result, 0, false);
		expect(result.nodes[0]).toMatchObject({ isInitial: true, isDeadEnd: true });
		expect(JSON.stringify(workflow)).toBe(before);
	});

	it('lays out cycles, disconnected states, repeated labels and hostile identifiers deterministically', () => {
		const workflow: GraphWorkflow = {
			states: [
				state('__proto__', 'Start', 'backlog'),
				state('constructor', '<script>alert(1)</script>'),
				state('c', 'Review'),
				state('d', 'Detached'),
				state('e', 'Done', 'done')
			],
			transitions: [
				{ id: 'a', name: 'Forward', from_state_id: '__proto__', to_state_id: 'constructor' },
				{ id: 'b', name: 'Forward', from_state_id: 'constructor', to_state_id: 'c' },
				{ id: 'c', name: 'Return', from_state_id: 'c', to_state_id: '__proto__' },
				{ id: 'd', name: 'Forward', from_state_id: 'd', to_state_id: 'e' },
				{ name: '', from_state_id: 'missing', to_state_id: 'e' }
			],
			initial_state_id: '__proto__'
		};
		const first = layoutWorkflowGraph(workflow, { compact: false });
		const second = layoutWorkflowGraph(workflow, { compact: false });
		expectUsable(first, 4, false);
		expect(first).toEqual(second);
		expect(first.edges.map((edge) => edge.label)).toEqual([
			'Forward',
			'Forward',
			'Return',
			'Forward'
		]);
		expect(new Set(first.edges.map((edge) => edge.key)).size).toBe(4);
		expectLabelsClear(first);
	});

	it('retains every parallel edge in compact cyclic graphs', () => {
		const workflow: GraphWorkflow = {
			states: [state('s0'), state('s1'), state('s2')],
			transitions: [
				{ id: 'loop-a', name: 'loop', from_state_id: 's0', to_state_id: 's0' },
				{ id: 'loop-b', name: 'loop', from_state_id: 's0', to_state_id: 's0' },
				{ id: 'a', name: 'same', from_state_id: 's0', to_state_id: 's1' },
				{ id: 'b', name: 'same', from_state_id: 's0', to_state_id: 's1' },
				{ id: 'c', name: 'same', from_state_id: 's0', to_state_id: 's1' },
				{ id: 'd', name: 'next', from_state_id: 's1', to_state_id: 's2' },
				{ id: 'e', name: 'back', from_state_id: 's2', to_state_id: 's0' }
			],
			initial_state_id: 's0'
		};
		const result = layoutWorkflowGraph(workflow, { compact: true });
		expectUsable(result, 7, true);
		expect(result.edges.every((edge) => edge.label === null && edge.labelBox === null)).toBe(true);
	});

	it('supports self-loops, duplicate temporary actions and complete wide Unicode labels', () => {
		const wide = `${'W'.repeat(100)}${'界'.repeat(100)}${'👩‍💻'.repeat(20)}`;
		const workflow: GraphWorkflow = {
			states: [state('a', wide, 'backlog'), state('b', 'e\u0301 emoji 😀')],
			transitions: [
				{ id: 'loop', name: wide, from_state_id: 'a', to_state_id: 'a' },
				{ id: 'loop', name: wide, from_state_id: 'a', to_state_id: 'a' },
				{ name: 'go', from_state_id: 'a', to_state_id: 'b' },
				{ name: 'go', from_state_id: 'a', to_state_id: 'b' },
				{ name: 'stay', from_state_id: 'b', to_state_id: 'b' }
			],
			initial_state_id: 'a'
		};
		const result = layoutWorkflowGraph(workflow, { compact: false });
		expectUsable(result, 5, false);
		expect(new Set(result.edges.map((edge) => edge.key)).size).toBe(5);
		expect(result.edges[0].label).toBe(wide);
		expectLabelsClear(result);
		expect(estimateTextWidth('界', 10)).toBe(15);
		expect(estimateTextWidth('😀', 10)).toBe(15);
	});

	it('keeps ID-based identity across label edits and rejects duplicate state IDs', () => {
		const base: GraphWorkflow = {
			states: [state('a'), state('b')],
			transitions: [{ id: 'stable-row', name: 'Before', from_state_id: 'a', to_state_id: 'b' }],
			initial_state_id: 'a'
		};
		const before = layoutWorkflowGraph(base, { compact: false });
		const after = layoutWorkflowGraph(
			{ ...base, transitions: [{ ...base.transitions[0], name: 'After' }] },
			{ compact: false }
		);
		expect(before.edges[0].key).toBe(after.edges[0].key);
		expect(
			layoutWorkflowGraph(
				{ states: [state('same'), state('same')], transitions: [], initial_state_id: 'same' },
				{ compact: false }
			).status
		).toBe('error');
	});
});
