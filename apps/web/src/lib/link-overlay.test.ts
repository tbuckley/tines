import type { IssueLinks, LinkedIssue, WorkflowState } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import { isTempLink, mergeLinks, TEMP_LINK_PREFIX, type PendingAdd } from './link-overlay';

const state: WorkflowState = { id: 's1', name: 'Open', category: 'active', position: 0, inherits_from: null };

const linked = (linkId: string, issueId: string): LinkedIssue => ({
	link_id: linkId,
	issue_id: issueId,
	project_name: 'demo',
	number: 1,
	title: 'T',
	effective_state: state
});

const empty: IssueLinks = { blocked_by: [], blocks: [], duplicate_of: null, duplicated_by: [] };
const add = (issueId: string, linkId: string): PendingAdd => ({
	group: 'blocked_by',
	entry: linked(linkId, issueId)
});

describe('mergeLinks', () => {
	it('passes server links through untouched with an empty overlay', () => {
		const server = { ...empty, blocked_by: [linked('l1', 'iA')] };
		expect(mergeLinks(server, [], [])).toEqual(server);
	});

	it('keeps a pending add visible through a reload that does not yet include it', () => {
		// The reported bug: add #1's reload landed while add #2 was in flight,
		// and the blind resync wiped add #2's row.
		const serverAfterFirstAdd = { ...empty, blocked_by: [linked('l1', 'iA')] };
		const secondAdd = add('iB', `${TEMP_LINK_PREFIX}iB-1`);
		const merged = mergeLinks(serverAfterFirstAdd, [secondAdd], []);
		expect(merged.blocked_by.map((l) => l.issue_id)).toEqual(['iA', 'iB']);
	});

	it('defers to the server row once the add has been delivered', () => {
		const server = { ...empty, blocked_by: [linked('l2', 'iB')] };
		const overlay = add('iB', 'l2');
		expect(mergeLinks(server, [overlay], []).blocked_by).toEqual(server.blocked_by);
	});

	it('keeps a pending removal hidden through a reload that still includes it', () => {
		// The reported bug, removal side: remove #1's reload landed while
		// remove #2 was in flight, and the resync flashed row #2 back.
		const serverAfterFirstRemoval = {
			...empty,
			blocked_by: [linked('l2', 'iB')]
		};
		expect(mergeLinks(serverAfterFirstRemoval, [], ['l2']).blocked_by).toEqual([]);
	});

	it('hides a pending add that was removed again before it reconciled', () => {
		const overlay = add('iB', 'l2');
		expect(mergeLinks(empty, [overlay], ['l2']).blocked_by).toEqual([]);
	});

	it('overlays a pending duplicate_of only while the server has none', () => {
		const pendingDup: PendingAdd = { group: 'duplicate_of', entry: linked('tmp', 'iC') };
		expect(mergeLinks(empty, [pendingDup], []).duplicate_of?.issue_id).toBe('iC');
		const server = { ...empty, duplicate_of: linked('l9', 'iC') };
		expect(mergeLinks(server, [pendingDup], []).duplicate_of?.link_id).toBe('l9');
	});

	it('hides a pending duplicate_of removal', () => {
		const server = { ...empty, duplicate_of: linked('l9', 'iC') };
		expect(mergeLinks(server, [], ['l9']).duplicate_of).toBeNull();
	});
});

describe('isTempLink', () => {
	it('flags only overlay placeholder ids', () => {
		expect(isTempLink(`${TEMP_LINK_PREFIX}iss_1-3`)).toBe(true);
		expect(isTempLink('lnk_abc123')).toBe(false);
	});
});
