import { describe, expect, it } from 'vitest';
import { getDb } from '$lib/server/db';
import { CLOSED, OPEN, PROJECT, USER, addIssue, seedBase } from '../supervisor/test-fixtures';
import { loadIssueLinks } from './issues';
import { createTestDb } from './test-db';
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

describe('loadIssueLinks D1 parameter budget', () => {
	it.each([94, 95, 181])('hydrates %i unique linked endpoints in link order', async (count) => {
		const t = createTestDb();
		seedBase(t);
		const root = addIssue(t, { id: `iss_root_${count}`, title: 'Root', state: OPEN });
		const endpointIds = Array.from({ length: count }, (_, index) => `iss_link_${count}_${index}`);
		const insertLink = t.sqlite.prepare(
			`INSERT INTO issue_link (id, source_issue_id, target_issue_id, kind, created_at)
			 VALUES (?, ?, ?, ?, 1)`
		);
		const expected = {
			blocked_by: [] as string[],
			blocks: [] as string[],
			duplicate_of: endpointIds[0],
			duplicated_by: [] as string[]
		};
		for (const [index, endpoint] of endpointIds.entries()) {
			addIssue(t, {
				id: endpoint,
				title: `Endpoint ${index}`,
				state: index === 0 ? CLOSED : OPEN
			});
			const linkId = `lnk_${index.toString().padStart(3, '0')}`;
			if (index === 0) {
				insertLink.run(linkId, root, endpoint, 'duplicate_of');
			} else if (index % 3 === 0) {
				insertLink.run(linkId, root, endpoint, 'blocks');
				expected.blocks.push(endpoint);
			} else if (index % 3 === 1) {
				insertLink.run(linkId, endpoint, root, 'blocks');
				expected.blocked_by.push(endpoint);
			} else {
				insertLink.run(linkId, endpoint, root, 'duplicate_of');
				expected.duplicated_by.push(endpoint);
			}
		}

		const links = await loadIssueLinks(getDb(t.env), USER, root);
		expect(links.blocks.map((link) => link.issue_id)).toEqual(expected.blocks);
		expect(links.blocked_by.map((link) => link.issue_id)).toEqual(expected.blocked_by);
		expect(links.duplicate_of?.issue_id).toBe(expected.duplicate_of);
		expect(links.duplicated_by.map((link) => link.issue_id)).toEqual(expected.duplicated_by);
		expect(links.duplicate_of).toMatchObject({
			project_name: 'demo',
			title: 'Endpoint 0',
			effective_state: { id: CLOSED, category: 'done' }
		});
		for (const link of links.duplicated_by) {
			expect(link.effective_state.id).toBe(CLOSED);
		}
	});

	it('handles no links, repeated endpoints across groups, and foreign endpoints', async () => {
		const t = createTestDb();
		seedBase(t);
		const root = addIssue(t, { id: 'iss_link_root' });
		expect(await loadIssueLinks(getDb(t.env), USER, root)).toEqual({
			blocked_by: [],
			blocks: [],
			duplicate_of: null,
			duplicated_by: []
		});

		const repeated = addIssue(t, { id: 'iss_repeated' });
		t.sqlite.exec(`
			INSERT INTO issue_link (id, source_issue_id, target_issue_id, kind, created_at) VALUES
				('lnk_repeat_block', '${root}', '${repeated}', 'blocks', 1),
				('lnk_repeat_dup', '${repeated}', '${root}', 'duplicate_of', 2);
			INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
				VALUES ('u2', 'bob', 'b@example.com', 1, 0, 0);
			INSERT INTO project (id, user_id, name, created_at, updated_at)
				VALUES ('prj_foreign', 'u2', 'foreign', 0, 0);
			INSERT INTO issue
				(id, project_id, number, title, description, workflow_id, state_id,
				 attempt_count, needs_attention, created_at, updated_at, state_entered_at)
				VALUES ('iss_foreign', 'prj_foreign', 1, 'Foreign', '', 'wf_standard',
					'${OPEN}', 0, 0, 0, 0, 0);
			INSERT INTO issue_link (id, source_issue_id, target_issue_id, kind, created_at)
				VALUES ('lnk_foreign', '${root}', 'iss_foreign', 'blocks', 3);
		`);

		const links = await loadIssueLinks(getDb(t.env), USER, root);
		expect(links.blocks.map((link) => link.issue_id)).toEqual([repeated]);
		expect(links.duplicated_by.map((link) => link.issue_id)).toEqual([repeated]);
		expect(links.blocks.some((link) => link.issue_id === 'iss_foreign')).toBe(false);
		expect(t.all('select id from project where id = ?', PROJECT)).toHaveLength(1);
	});
});
