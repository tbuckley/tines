import {
	recordDispatchEffects,
	TEST_NOOP_DISPATCH_EFFECTS
} from '$lib/server/api/test-dispatch-effects';
import { describe, expect, it } from 'vitest';
import { addIssue, seedBase, USER } from '../supervisor/test-fixtures';
import { addIssueLink, removeIssueLink } from './issue-links';
import { createTestDb, type TestDb } from './test-db';
import type { ActorContext } from './core';

const actor: ActorContext = {
	userId: USER,
	userName: 'Alice',
	apiKeyId: 'key_first',
	apiKeyName: 'first-agent',
	viaSession: false
};

const competingActor: ActorContext = {
	...actor,
	apiKeyId: 'key_second',
	apiKeyName: 'second-agent'
};

function delayedBy(
	t: TestDb,
	competing: () => Promise<unknown>,
	afterBatch?: () => Promise<unknown>
): Env {
	const delayedEnv = { ...t.env, DB: Object.create(t.env.DB) } as Env;
	let injected = false;
	delayedEnv.DB.batch = async <T = unknown>(statements: Parameters<Env['DB']['batch']>[0]) => {
		if (!injected) {
			injected = true;
			await competing();
		}
		const result = await t.env.DB.batch<T>(statements);
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
	return t.all(
		"SELECT issue_id, project_id, actor_user_id, actor_api_key_id, payload FROM event WHERE type = 'issue.link_added' ORDER BY issue_id"
	);
}

function expectWinnerEvents(
	t: TestDb,
	input: {
		source: string;
		target: string;
		linkId: string;
		kind?: 'blocks' | 'duplicate_of';
		actorId?: string;
		sourceProject?: string;
		targetProject?: string;
		peerProjectNames?: Partial<Record<'source' | 'target', string>>;
	}
) {
	const rows = linkEvents(t).filter((row) => {
		const payload = JSON.parse(row.payload as string) as { link_id: string };
		return payload.link_id === input.linkId;
	});
	expect(rows).toHaveLength(2);
	const byIssue = new Map(rows.map((row) => [row.issue_id, row]));
	for (const [self, peer, role, project] of [
		[input.source, input.target, 'source', input.sourceProject ?? 'prj_1'],
		[input.target, input.source, 'target', input.targetProject ?? 'prj_1']
	] as const) {
		const row = byIssue.get(self)!;
		expect(row).toMatchObject({
			issue_id: self,
			project_id: project,
			actor_user_id: USER,
			actor_api_key_id: input.actorId ?? actor.apiKeyId
		});
		const payload = JSON.parse(row.payload as string);
		const peerRow = t.all(
			`SELECT issue.id, issue.number, issue.title, project.name AS project_name
			 FROM issue JOIN project ON project.id = issue.project_id WHERE issue.id = ?`,
			peer
		)[0];
		expect(payload).toEqual({
			link_id: input.linkId,
			kind: input.kind ?? 'blocks',
			role,
			other_issue_id: peer,
			other_project_name: input.peerProjectNames?.[role] ?? peerRow.project_name,
			other_number: peerRow.number,
			other_title: peerRow.title
		});
	}
}

function expectAcyclic(t: TestDb) {
	const graph = new Map<string, string[]>();
	for (const row of edges(t)) {
		const outgoing = graph.get(row.source as string) ?? [];
		outgoing.push(row.target as string);
		graph.set(row.source as string, outgoing);
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (node: string): boolean => {
		if (visiting.has(node)) return false;
		if (visited.has(node)) return true;
		visiting.add(node);
		for (const target of graph.get(node) ?? []) if (!visit(target)) return false;
		visiting.delete(node);
		visited.add(node);
		return true;
	};
	for (const node of graph.keys()) expect(visit(node), `cycle through ${node}`).toBe(true);
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
	t.sqlite.exec(`
		INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, created_at) VALUES
			('key_first', '${USER}', 'first-agent', 'hash-1', 'first', 1),
			('key_second', '${USER}', 'second-agent', 'hash-2', 'second', 1);
		INSERT INTO project (id, user_id, name, created_at, updated_at)
		VALUES ('prj_2', '${USER}', 'other-project', 1, 1);
	`);
	const ids = Object.fromEntries(
		['a', 'b', 'c', 'd', 'e'].map((name) => [
			name,
			addIssue(t, { id: `iss_${name}`, title: `Issue ${name.toUpperCase()}` })
		])
	) as Record<'a' | 'b' | 'c' | 'd' | 'e', string>;
	return { t, ...ids };
}

describe('dispatch effects: issue-link owners', () => {
	it.each(['add', 'remove'] as const)(
		'signals a committed %s and not a rejected batch',
		async (owner) => {
			const success = fixture();
			const successEffects = recordDispatchEffects();
			const link = await addIssueLink(
				success.t.db,
				success.t.env,
				actor,
				successEffects,
				success.a,
				{
					kind: 'blocks',
					issue_id: success.b
				}
			);
			if (owner === 'remove') {
				await removeIssueLink(
					success.t.db,
					success.t.env,
					actor,
					successEffects,
					success.a,
					link.id
				);
			}
			expect(successEffects.count()).toBe(owner === 'add' ? 1 : 2);

			const rejected = fixture();
			const existing =
				owner === 'remove'
					? await addIssueLink(
							rejected.t.db,
							rejected.t.env,
							actor,
							TEST_NOOP_DISPATCH_EFFECTS,
							rejected.a,
							{ kind: 'blocks', issue_id: rejected.b }
						)
					: null;
			const beforeEdges = edges(rejected.t);
			const beforeEvents = linkEvents(rejected.t);
			const rejectedEffects = recordDispatchEffects();
			rejected.t.env.DB.batch = async () => {
				throw new Error(`injected link ${owner} batch failure`);
			};
			const call =
				owner === 'add'
					? addIssueLink(rejected.t.db, rejected.t.env, actor, rejectedEffects, rejected.a, {
							kind: 'blocks',
							issue_id: rejected.b
						})
					: removeIssueLink(
							rejected.t.db,
							rejected.t.env,
							actor,
							rejectedEffects,
							rejected.a,
							existing!.id
						);
			await expect(call).rejects.toThrow(`injected link ${owner} batch failure`);
			expect(rejectedEffects.count()).toBe(0);
			expect(edges(rejected.t)).toEqual(beforeEdges);
			expect(linkEvents(rejected.t)).toEqual(beforeEvents);
		}
	);
});

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
		for (const reverse of [false, true]) {
			it(`rejects the delayed half of ${name} (${reverse ? 'reverse' : 'forward'} winner)`, async () => {
				const { t, a, b } = fixture();
				let winner: Awaited<ReturnType<typeof addIssueLink>> | undefined;
				const immediate = reverse
					? { actor: competingActor, issue: a, body: first }
					: { actor: competingActor, issue: b, body: second };
				const delayed = reverse
					? { actor, issue: b, body: second }
					: { actor, issue: a, body: first };
				const env = delayedBy(t, async () => {
					winner = await addIssueLink(
						t.db,
						t.env,
						immediate.actor,
						TEST_NOOP_DISPATCH_EFFECTS,
						immediate.issue,
						immediate.body
					);
				});
				await expectCycle(
					addIssueLink(
						t.db,
						env,
						delayed.actor,
						TEST_NOOP_DISPATCH_EFFECTS,
						delayed.issue,
						delayed.body
					),
					['demo/']
				);
				expect(edges(t)).toHaveLength(1);
				expectAcyclic(t);
				expectWinnerEvents(t, {
					source: winner!.source_issue_id,
					target: winner!.target_issue_id,
					linkId: winner!.id,
					kind: winner!.kind,
					actorId: competingActor.apiKeyId!
				});
			});
		}
	}

	it('rejects a four-node cycle across disjoint competing endpoint pairs', async () => {
		const { t, a, b, c, d } = fixture();
		await addIssueLink(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, a, {
			kind: 'blocks',
			issue_id: b
		});
		await addIssueLink(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, c, {
			kind: 'blocks',
			issue_id: d
		});
		const env = delayedBy(t, () =>
			addIssueLink(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, d, {
				kind: 'blocks',
				issue_id: a
			})
		);
		await expectCycle(
			addIssueLink(t.db, env, actor, TEST_NOOP_DISPATCH_EFFECTS, b, {
				kind: 'blocks',
				issue_id: c
			}),
			['demo/']
		);
		expect(edges(t)).toHaveLength(3);
		expect(linkEvents(t)).toHaveLength(6);
	});

	it('accepts concurrent additions whose union is acyclic', async () => {
		const { t, a, b, c, d } = fixture();
		let first: Awaited<ReturnType<typeof addIssueLink>> | undefined;
		const env = delayedBy(t, async () => {
			first = await addIssueLink(t.db, t.env, competingActor, TEST_NOOP_DISPATCH_EFFECTS, c, {
				kind: 'blocks',
				issue_id: d
			});
		});
		const second = await addIssueLink(t.db, env, actor, TEST_NOOP_DISPATCH_EFFECTS, a, {
			kind: 'blocks',
			issue_id: b
		});
		expect(edges(t)).toHaveLength(2);
		expectAcyclic(t);
		expectWinnerEvents(t, {
			source: c,
			target: d,
			linkId: first!.id,
			actorId: competingActor.apiKeyId!
		});
		expectWinnerEvents(t, { source: a, target: b, linkId: second.id });
	});

	it('accepts shared-node and cross-project concurrent additions', async () => {
		const { t, a, b, c } = fixture();
		t.sqlite.prepare("UPDATE issue SET project_id = 'prj_2' WHERE id = ?").run(c);
		let first: Awaited<ReturnType<typeof addIssueLink>> | undefined;
		const env = delayedBy(t, async () => {
			first = await addIssueLink(t.db, t.env, competingActor, TEST_NOOP_DISPATCH_EFFECTS, a, {
				kind: 'blocks',
				issue_id: b
			});
		});
		const second = await addIssueLink(t.db, env, actor, TEST_NOOP_DISPATCH_EFFECTS, b, {
			kind: 'blocks',
			issue_id: c
		});
		expectAcyclic(t);
		expectWinnerEvents(t, {
			source: a,
			target: b,
			linkId: first!.id,
			actorId: competingActor.apiKeyId!
		});
		expectWinnerEvents(t, {
			source: b,
			target: c,
			linkId: second.id,
			targetProject: 'prj_2'
		});
	});

	it('normalizes blocked_by before applying the same guard', async () => {
		const { t, a, b } = fixture();
		const env = delayedBy(t, () =>
			addIssueLink(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, b, {
				kind: 'blocked_by',
				issue_id: a
			})
		);
		await expectCycle(
			addIssueLink(t.db, env, actor, TEST_NOOP_DISPATCH_EFFECTS, a, {
				kind: 'blocked_by',
				issue_id: b
			}),
			['demo/']
		);
		expect(edges(t)).toEqual([{ source: a, target: b, kind: 'blocks' }]);
	});

	it('preserves exact-link and one-canonical-duplicate error precedence under a race', async () => {
		const { t, a, b, c } = fixture();
		let env = delayedBy(t, () =>
			addIssueLink(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, a, {
				kind: 'blocks',
				issue_id: b
			})
		);
		await expect(
			addIssueLink(t.db, env, actor, TEST_NOOP_DISPATCH_EFFECTS, a, { kind: 'blocks', issue_id: b })
		).rejects.toMatchObject({ status: 409, code: 'conflict' });

		env = delayedBy(t, () =>
			addIssueLink(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, c, {
				kind: 'duplicate_of',
				issue_id: a
			})
		);
		await expect(
			addIssueLink(t.db, env, actor, TEST_NOOP_DISPATCH_EFFECTS, c, {
				kind: 'duplicate_of',
				issue_id: b
			})
		).rejects.toMatchObject({
			status: 422,
			code: 'already_duplicate',
			details: { duplicate_of: { project_name: 'demo', title: 'Issue A' } }
		});
		expect(edges(t)).toHaveLength(2);
		expect(linkEvents(t)).toHaveLength(4);
	});

	it('preserves the exact duplicate_of conflict under a race', async () => {
		const { t, a, b } = fixture();
		const env = delayedBy(t, () =>
			addIssueLink(t.db, t.env, competingActor, TEST_NOOP_DISPATCH_EFFECTS, a, {
				kind: 'duplicate_of',
				issue_id: b
			})
		);
		await expect(
			addIssueLink(t.db, env, actor, TEST_NOOP_DISPATCH_EFFECTS, a, {
				kind: 'duplicate_of',
				issue_id: b
			})
		).rejects.toMatchObject({ status: 422, code: 'already_duplicate' });
		expect(edges(t)).toEqual([{ source: a, target: b, kind: 'duplicate_of' }]);
		expect(linkEvents(t)).toHaveLength(2);
	});

	it('returns the transaction-time cycle path even if that path is removed before formatting', async () => {
		const { t, a, b } = fixture();
		const link = await addIssueLink(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, a, {
			kind: 'blocks',
			issue_id: b
		});
		const env = delayedBy(
			t,
			async () => {},
			() => removeIssueLink(t.db, t.env, competingActor, TEST_NOOP_DISPATCH_EFFECTS, a, link.id)
		);
		await expectCycle(
			addIssueLink(t.db, env, actor, TEST_NOOP_DISPATCH_EFFECTS, b, {
				kind: 'blocks',
				issue_id: a
			}),
			['demo/']
		);
		expect(edges(t)).toEqual([]);
		expect(linkEvents(t)).toHaveLength(2);
		expect(t.all("SELECT * FROM event WHERE type = 'issue.link_removed'")).toHaveLength(2);
	});

	it('accepts an addition when a competing removal commits first', async () => {
		const { t, a, b } = fixture();
		const old = await addIssueLink(t.db, t.env, competingActor, TEST_NOOP_DISPATCH_EFFECTS, a, {
			kind: 'blocks',
			issue_id: b
		});
		const env = delayedBy(t, () =>
			removeIssueLink(t.db, t.env, competingActor, TEST_NOOP_DISPATCH_EFFECTS, a, old.id)
		);
		const replacement = await addIssueLink(t.db, env, actor, TEST_NOOP_DISPATCH_EFFECTS, b, {
			kind: 'blocks',
			issue_id: a
		});
		expect(edges(t)).toEqual([{ source: b, target: a, kind: 'blocks' }]);
		expectAcyclic(t);
		expectWinnerEvents(t, { source: b, target: a, linkId: replacement.id });
	});

	it('uses transferred endpoint projects for event ownership and cycle diagnostics', async () => {
		const { t, a, b } = fixture();
		const env = delayedBy(t, async () => {
			t.sqlite.prepare("UPDATE issue SET project_id = 'prj_2' WHERE id = ?").run(b);
		});
		const link = await addIssueLink(t.db, env, actor, TEST_NOOP_DISPATCH_EFFECTS, a, {
			kind: 'blocks',
			issue_id: b
		});
		expectWinnerEvents(t, {
			source: a,
			target: b,
			linkId: link.id,
			targetProject: 'prj_2',
			peerProjectNames: { source: 'other-project' }
		});

		const diagnosticEnv = delayedBy(t, async () => {
			t.sqlite.prepare("UPDATE issue SET project_id = 'prj_2' WHERE id = ?").run(a);
		});
		await expectCycle(
			addIssueLink(t.db, diagnosticEnv, actor, TEST_NOOP_DISPATCH_EFFECTS, b, {
				kind: 'blocks',
				issue_id: a
			}),
			['other-project/']
		);
		expect(edges(t)).toHaveLength(1);
		expect(linkEvents(t)).toHaveLength(2);
	});

	it('uses fixed-size statements and terminates through a seeded legacy cycle', async () => {
		const { t, a, b, c } = fixture();
		t.sqlite.exec(`
			INSERT INTO issue_link VALUES ('legacy_ab', '${a}', '${b}', 'blocks', 1);
			INSERT INTO issue_link VALUES ('legacy_ba', '${b}', '${a}', 'blocks', 1);
		`);
		const seen: { sqlText: string; params: unknown[] }[] = [];
		const env = { ...t.env, DB: Object.create(t.env.DB) } as Env;
		env.DB.batch = async <T = unknown>(statements: Parameters<Env['DB']['batch']>[0]) => {
			seen.push(...(statements as unknown as { sqlText: string; params: unknown[] }[]));
			return t.env.DB.batch<T>(statements);
		};
		await addIssueLink(t.db, env, actor, TEST_NOOP_DISPATCH_EFFECTS, c, {
			kind: 'blocks',
			issue_id: a
		});
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
			await addIssueLink(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, chain.at(-1)!, {
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
				addIssueLink(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, a, {
					kind: 'blocks',
					issue_id: b
				})
			).rejects.toThrow('injected event failure');
			expect(edges(t)).toEqual([]);
			expect(linkEvents(t)).toEqual([]);
		});
	}

	it('rolls back the link and events when the final diagnostic statement fails', async () => {
		const { t, a, b } = fixture();
		const env = { ...t.env, DB: Object.create(t.env.DB) } as Env;
		env.DB.batch = async <T = unknown>(statements: Parameters<Env['DB']['batch']>[0]) => {
			const broken = [...statements];
			broken[broken.length - 1] = t.env.DB.prepare('SELECT missing_column FROM issue');
			return t.env.DB.batch<T>(broken);
		};
		await expect(
			addIssueLink(t.db, env, actor, TEST_NOOP_DISPATCH_EFFECTS, a, { kind: 'blocks', issue_id: b })
		).rejects.toThrow();
		expect(edges(t)).toEqual([]);
		expect(linkEvents(t)).toEqual([]);
	});

	for (const corruption of ['missing', 'malformed'] as const) {
		it(`never reports success for a ${corruption} batch receipt`, async () => {
			const { t, a, b } = fixture();
			const env = { ...t.env, DB: Object.create(t.env.DB) } as Env;
			env.DB.batch = async <T = unknown>(statements: Parameters<Env['DB']['batch']>[0]) => {
				const results = await t.env.DB.batch<T>(statements);
				const receipt = results[3] as { results: unknown[] };
				receipt.results = corruption === 'missing' ? [] : [{ inserted: 9 }];
				return results;
			};
			await expect(
				addIssueLink(t.db, env, actor, TEST_NOOP_DISPATCH_EFFECTS, a, {
					kind: 'blocks',
					issue_id: b
				})
			).rejects.toThrow(/receipt/);
			expect(edges(t)).toHaveLength(1);
			expect(linkEvents(t)).toHaveLength(2);
		});
	}

	it('never reports a cycle rejection from a missing diagnostic receipt', async () => {
		const { t, a, b } = fixture();
		await addIssueLink(t.db, t.env, competingActor, TEST_NOOP_DISPATCH_EFFECTS, a, {
			kind: 'blocks',
			issue_id: b
		});
		const env = { ...t.env, DB: Object.create(t.env.DB) } as Env;
		env.DB.batch = async <T = unknown>(statements: Parameters<Env['DB']['batch']>[0]) => {
			const results = await t.env.DB.batch<T>(statements);
			(results[4] as { results: unknown }).results = null;
			return results;
		};
		await expect(
			addIssueLink(t.db, env, actor, TEST_NOOP_DISPATCH_EFFECTS, b, { kind: 'blocks', issue_id: a })
		).rejects.toThrow(/diagnostic/);
		expect(edges(t)).toEqual([{ source: a, target: b, kind: 'blocks' }]);
		expect(linkEvents(t)).toHaveLength(2);
	});

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
			addIssueLink(t.db, env, actor, TEST_NOOP_DISPATCH_EFFECTS, a, { kind: 'blocks', issue_id: b })
		).rejects.toMatchObject({ status: 404 });
		expect(edges(t)).toEqual([]);
		expect(linkEvents(t)).toEqual([]);
	});
});
