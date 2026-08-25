import { describe, expect, it } from 'vitest';
import { findLinkPath, type LinkEdge } from './issue-links';

const edge = (source: string, target: string): LinkEdge => ({ source, target });

describe('findLinkPath', () => {
	it('finds a direct edge', () => {
		expect(findLinkPath([edge('a', 'b')], 'a', 'b')).toEqual(['a', 'b']);
	});

	it('finds a multi-hop path across mixed edges', () => {
		const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')];
		expect(findLinkPath(edges, 'a', 'd')).toEqual(['a', 'b', 'c', 'd']);
	});

	it('returns the trivial path when from equals to', () => {
		expect(findLinkPath([], 'a', 'a')).toEqual(['a']);
	});

	it('returns null when the target is unreachable', () => {
		expect(findLinkPath([edge('a', 'b')], 'b', 'a')).toBeNull();
	});

	it('ignores edge direction correctly (no traversal against the arrow)', () => {
		const edges = [edge('a', 'b'), edge('c', 'b')];
		expect(findLinkPath(edges, 'a', 'c')).toBeNull();
	});

	it('prefers a shortest path when several exist', () => {
		const edges = [edge('a', 'b'), edge('b', 'c'), edge('a', 'c')];
		expect(findLinkPath(edges, 'a', 'c')).toEqual(['a', 'c']);
	});

	it('terminates on a pre-existing cycle', () => {
		const edges = [edge('a', 'b'), edge('b', 'a')];
		expect(findLinkPath(edges, 'a', 'z')).toBeNull();
	});

	it('handles fan-out graphs', () => {
		const edges = [edge('a', 'b'), edge('a', 'c'), edge('c', 'd'), edge('b', 'd'), edge('d', 'e')];
		const path = findLinkPath(edges, 'a', 'e');
		expect(path?.[0]).toBe('a');
		expect(path?.[path.length - 1]).toBe('e');
		expect(path?.length).toBe(4);
	});
});
