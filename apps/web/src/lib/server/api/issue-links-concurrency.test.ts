import { describe, expect, it } from 'vitest';
import { addIssue, seedBase, USER } from '../supervisor/test-fixtures';
import { addIssueLink } from './issue-links';
import { createTestDb, type TestDb } from './test-db';
import type { ActorContext } from './core';

const actor: ActorContext = {
	userId: USER,
	userName: 'Alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

function delayedBy(
	t: TestDb,
	competing: () => Promise<unknown>,
	afterBatch?: () => Promise<unknown>
): Env {
	const delayedEnv = { ...t.env, DB: Object.create(t.env.DB) } as Env;
	let injected = false;
	const realBatch = t.env.DB.batch.bind(t.env.DB);
	delayedEnv.DB.batch = async (statements) => {
		if (!injected) {
			injected = true;
			await competing();
		}
		const result = await realBatch(statements);
		await afterBatch?.();
		return result;
	};
	return delayedEnv;
}

function edges(t: TestDb) {
	return t.all(
		'SELECT source_issue_id AS source, target_issue_id AS target, kind FROM issue_link ORDER BY source, target'
	);
}

function linkEvents(t: TestDb) {
	return t.all("SELECT issue_id, payload FROM event WHERE type = 'issue.link_added'");
}

async function expectCycle(promise: Promise<unknown>, refs: string[]) {
	try {
		await promise;
		expect.fail('expected link_cycle');
	} catch (error) {
		expect(error).toMatchObject({ status: 422, code: 'link_cycle' });
		const apiError = error as { message: string; details: { path: { issue_id: string }[] } };
		for (const ref of refs) expect(apiError.message).toContain(ref);
		const ids = apiError.details.path.map((item) => item.issue_id);
		expect(ids[0]).toBe(ids.at(-1));
	}
}

function fixture() {
	const t = createTestDb();
	seedBase(t);
	const ids = Object.fromEntries(
		['a', 'b', 'c', 'd', 'e'].map((name) => [
			name,
			addIssue(t, { id: `iss_${name}`, title: `Issue ${name.toUpperCase()}` })
		])
	) as Record<'a' | 'b' | 'c' | 'd' | 'e', string>;
	return { t, ...ids };
}

describe('commit-time issue-link graph guard', () => {
	for (const [name, first, second] of [
		[
			'reciprocal blocks',
			{ kind: 'blocks', issue_id: 'iss_b' },
			{ kind: 'blocks', issue_id: 'iss_a' }
		],
		[
			'reciprocal duplicate-only',
			{ kind: 'duplicate_of', issue_id: 'iss_b' },
			{ kind: 'duplicate_of', issue_id: 'iss_a' }
		],
		[
			'mixed block and duplicate',
			{ kind: 'blocks', issue_id: 'iss_b' },
			{ kind: 'duplicate_of', issue_id: 'iss_a' }
		]
	] as const) {
		it(`rejects the delayed half of ${name}`, async () => {
			const { t, a, b } = fixture();
			const env = delayedBy(t, () => addIssueLink(t.db, t.env, actor, b, second));
			await expectCycle(addIssueLink(t.db, env, actor, a, first), ['demo/']);
			expect(edges(t)).toHaveLength(1);
			expect(linkEvents(t)).toHaveLength(2);
		});
	}

	it('rejects a four-node cycle across disjoint competing endpoint pairs', async () => {
		const { t, a, b, c, d } = fixture();
		await addIssueLink(t.db, t.env, actor, a, { kind: 'blocks', issue_id: b });
		await addIssueLink(t.db, t.env, actor, c, { kind: 'blocks', issue_id: d });
		const env = delayedBy(t, () =>
			addIssueLink(t.db, t.env, actor, d, { kind: 'blocks', issue_id: a })
		);
		await expectCycle(addIssueLink(t.db, env, actor, b, { kind: 'blocks', issue_id: c }), [
			'demo/'
		]);
		expect(edges(t)).toHaveLength(3);
		expect(linkEvents(t)).toHaveLength(6);
	});

	it('accepts concurrent additions whose union is acyclic', async () => {
		const { t, a, b, c, d } = fixture();
		const env = delayedBy(t, () =>
			addIssueLink(t.db, t.env, actor, c, { kind: 'blocks', issue_id: d })
		);
		await addIssueLink(t.db, env, actor, a, { kind: 'blocks', issue_id: b });
		expect(edges(t)).toHaveLength(2);
		expect(linkEvents(t)).toHaveLength(4);
	});

	it('normalizes blocked_by before applying the same guard', async () => {
		const { t, a, b } = fixture();
		const env = delayedBy(t, () =>
			addIssueLink(t.db, t.env, actor, b, { kind: 'blocked_by', issue_id: a })
		);
		await expectCycle(addIssueLink(t.db, env, actor, a, { kind: 'blocked_by', issue_id: b }), [
			'demo/'
		]);
		expect(edges(t)).toEqual([{ source: a, target: b, kind: 'blocks' }]);
	});

	it('preserves exact-link and one-canonical-duplicate error precedence under a race', async () => {
		const { t, a, b, c } = fixture();
		let env = delayedBy(t, () =>
			addIssueLink(t.db, t.env, actor, a, { kind: 'blocks', issue_id: b })
		);
		await expect(
			addIssueLink(t.db, env, actor, a, { kind: 'blocks', issue_id: b })
		).rejects.toMatchObject({ status: 409, code: 'conflict' });

		env = delayedBy(t, () =>
			addIssueLink(t.db, t.env, actor, c, { kind: 'duplicate_of', issue_id: a })
		);
		await expect(
			addIssueLink(t.db, env, actor, c, { kind: 'duplicate_of', issue_id: b })
		).rejects.toMatchObject({
			status: 422,
			code: 'already_duplicate',
			details: { duplicate_of: { project_name: 'demo', title: 'Issue A' } }
		});
		expect(edges(t)).toHaveLength(2);
		expect(linkEvents(t)).toHaveLength(4);
	});

	it('returns the transaction-time cycle path even if that path is removed before formatting', async () => {
		const { t, a, b } = fixture();
		const link = await addIssueLink(t.db, t.env, actor, a, { kind: 'blocks', issue_id: b });
		const env = delayedBy(
			t,
			async () => {},
			async () => {
				t.sqlite.prepare('DELETE FROM issue_link WHERE id = ?').run(link.id);
			}
		);
		await expectCycle(addIssueLink(t.db, env, actor, b, { kind: 'blocks', issue_id: a }), [
			'demo/'
		]);
		expect(edges(t)).toEqual([]);
		expect(linkEvents(t)).toHaveLength(2);
	});

	it('uses fixed-size statements and terminates through a seeded legacy cycle', async () => {
		const { t, a, b, c } = fixture();
		t.sqlite.exec(`
			INSERT INTO issue_link VALUES ('legacy_ab', '${a}', '${b}', 'blocks', 1);
			INSERT INTO issue_link VALUES ('legacy_ba', '${b}', '${a}', 'blocks', 1);
		`);
		const seen: { sqlText: string; params: unknown[] }[] = [];
		const realBatch = t.env.DB.batch.bind(t.env.DB);
		const env = { ...t.env, DB: Object.create(t.env.DB) } as Env;
		env.DB.batch = async (statements) => {
			seen.push(...(statements as unknown as { sqlText: string; params: unknown[] }[]));
			return realBatch(statements);
		};
		await addIssueLink(t.db, env, actor, c, { kind: 'blocks', issue_id: a });
		expect(seen).toHaveLength(5);
		for (const statement of seen) {
			expect(statement.params.length).toBeLessThanOrEqual(100);
			expect(statement.sqlText.length).toBeLessThan(100_000);
		}
	});

	it('returns a complete diagnostic path beyond the D1 binding limit', async () => {
		const t = createTestDb();
		seedBase(t);
		const chain = Array.from({ length: 121 }, (_, index) =>
			addIssue(t, { id: `iss_chain_${index}`, title: `Chain ${index}` })
		);
		const insert = t.sqlite.prepare(
			'INSERT INTO issue_link (id, source_issue_id, target_issue_id, kind, created_at) VALUES (?, ?, ?, ?, ?)'
		);
		for (let index = 0; index < chain.length - 1; index++) {
			insert.run(`lnk_chain_${index}`, chain[index], chain[index + 1], 'blocks', index);
		}
		try {
			await addIssueLink(t.db, t.env, actor, chain.at(-1)!, {
				kind: 'blocks',
				issue_id: chain[0]
			});
			expect.fail('expected link_cycle');
		} catch (error) {
			expect(error).toMatchObject({ status: 422, code: 'link_cycle' });
			expect(
				(error as { details: { path: unknown[] } }).details.path,
				'the new edge plus all 120 existing hops'
			).toHaveLength(122);
		}
		expect(edges(t)).toHaveLength(120);
		expect(linkEvents(t)).toEqual([]);
	});

	for (const role of ['source', 'target'] as const) {
		it(`rolls back the link and both events when the ${role} event fails`, async () => {
			const { t, a, b } = fixture();
			const failedIssue = role === 'source' ? a : b;
			t.sqlite.exec(`
				CREATE TRIGGER reject_link_event BEFORE INSERT ON event
				WHEN NEW.type = 'issue.link_added' AND NEW.issue_id = '${failedIssue}'
				BEGIN SELECT RAISE(ABORT, 'injected event failure'); END;
			`);
			await expect(
				addIssueLink(t.db, t.env, actor, a, { kind: 'blocks', issue_id: b })
			).rejects.toThrow('injected event failure');
			expect(edges(t)).toEqual([]);
			expect(linkEvents(t)).toEqual([]);
		});
	}

	it('rechecks endpoint ownership inside the batch and emits nothing after a cross-account move', async () => {
		const { t, a, b } = fixture();
		t.sqlite.exec(`
			INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
			VALUES ('u2', 'Bob', 'bob@example.com', 1, 1, 1);
			INSERT INTO project (id, user_id, name, created_at, updated_at)
			VALUES ('prj_other', 'u2', 'other', 1, 1);
		`);
		const env = delayedBy(t, async () => {
			t.sqlite.prepare("UPDATE issue SET project_id = 'prj_other' WHERE id = ?").run(b);
		});
		await expect(
			addIssueLink(t.db, env, actor, a, { kind: 'blocks', issue_id: b })
		).rejects.toMatchObject({ status: 404 });
		expect(edges(t)).toEqual([]);
		expect(linkEvents(t)).toEqual([]);
	});
});
