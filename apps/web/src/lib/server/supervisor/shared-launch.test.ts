import { beforeEach, describe, expect, it } from 'vitest';
import { createContextItem } from '../api/context';
import type { ActorContext } from '../api/core';
import { BUNDLE_ITEM_CAP } from '../api/shared-execution-bundle';
import { createTestDb, type TestDb } from '../api/test-db';
import { claimRun, launchClaimedRun } from './engine';
import { createFakeAdapter } from './fake-adapter';
import {
	GUIDANCE_CHURN_BACKOFF_MS,
	GUIDANCE_REFUSAL_BACKOFF_MS,
	admitSharedRun,
	usesSharedLaunch
} from './shared-launch';
import { NOW, OPEN, PROJECT, USER, addIssue, addRunner, seedBase } from './test-fixtures';

const session: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

let t: TestDb;
let issue: string;
let runner: string;
let seq = 0;

const prompt = (name: string) =>
	createContextItem(t.db, t.env, session, {
		kind: 'prompt',
		name,
		body: name.toUpperCase(),
		project_id: PROJECT
	} as never);

async function claim(now = NOW): Promise<{ id: boolean; runId: string }> {
	const runId = `arun_shared_${++seq}`;
	const id = await claimRun(t.db, t.env, {
		runId,
		userId: USER,
		issueId: issue,
		projectId: PROJECT,
		stateId: OPEN,
		runnerId: runner,
		maxConcurrent: 5,
		tier: 'balanced',
		model: null,
		quota: { type: 'global_cap', limit: 10 },
		now
	});
	return { id, runId };
}

const runRow = (runId: string) =>
	t.all('SELECT * FROM agent_run WHERE id = ?', runId)[0] as Record<string, unknown>;
const keys = (runId: string) => t.all('SELECT * FROM api_key WHERE agent_run_id = ?', runId);
const blocks = () => t.all('SELECT * FROM issue_guidance_block');

function admit(runId: string, beforeMint?: (attempt: number) => Promise<void>) {
	return admitSharedRun(t.env, t.db, runRow(runId) as never, {
		maxRunMinutes: 30,
		now: NOW,
		envChannel: false,
		beforeMint
	});
}

beforeEach(() => {
	t = createTestDb();
	seedBase(t);
	runner = addRunner(t);
	issue = addIssue(t);
	t.sqlite
		.prepare('UPDATE project SET shared_at = ?, sharing_revision = 1 WHERE id = ?')
		.run(NOW, PROJECT);
});

describe('usesSharedLaunch', () => {
	it('is on only with the flag on and a shared project', async () => {
		expect(await usesSharedLaunch(t.env, t.db, issue)).toBe(false);
		const on = { ...t.env, SHARED_EXECUTION: 'on' } as unknown as Env;
		expect(await usesSharedLaunch(on, t.db, issue)).toBe(true);
		t.sqlite.prepare('UPDATE project SET shared_at = NULL WHERE id = ?').run(PROJECT);
		expect(await usesSharedLaunch(on, t.db, issue)).toBe(false);
	});
});

describe('admitSharedRun', () => {
	it('builds the material before the key and mints under the witness', async () => {
		await prompt('house-rules');
		const { runId } = await claim();
		const admitted = await admit(runId);
		expect(admitted.kind).toBe('admitted');
		if (admitted.kind !== 'admitted') return;
		expect(admitted.material.launchPrompt).toContain('HOUSE-RULES');
		expect(admitted.material.bundle.guidance.env).toEqual([]);
		expect(runRow(runId)).toMatchObject({ status: 'launching', api_key_id: admitted.keyId });
		expect(keys(runId)).toHaveLength(1);
	});

	it('rebuilds once when guidance changes between material and mint', async () => {
		const { runId } = await claim();
		const admitted = await admit(runId, async (attempt) => {
			if (attempt === 1) await prompt('late-arrival');
		});
		expect(admitted.kind).toBe('admitted');
		if (admitted.kind !== 'admitted') return;
		expect(admitted.material.launchPrompt).toContain('LATE-ARRIVAL');
		expect(keys(runId)).toHaveLength(1);
	});

	it('releases without a strike, leaves no key and holds the issue back after two losses', async () => {
		const { runId } = await claim();
		const admitted = await admit(runId, async (attempt) => {
			await prompt(`churn-${attempt}`);
		});
		expect(admitted).toEqual({ kind: 'released', error: 'guidance bundle unavailable: churn' });
		expect(runRow(runId)).toMatchObject({ status: 'canceled', api_key_id: null });
		expect(keys(runId)).toHaveLength(0);
		expect(t.all('SELECT attempt_count FROM issue WHERE id = ?', issue)[0]).toMatchObject({
			attempt_count: 0
		});
		expect(blocks()).toMatchObject([
			{
				issue_id: issue,
				code: 'bundle_unavailable',
				reason: 'churn',
				retry_after: NOW + GUIDANCE_CHURN_BACKOFF_MS
			}
		]);
		// The claim waits out the hold, then succeeds; admission clears it.
		expect((await claim(NOW + 1)).id).toBe(false);
		const later = await claim(NOW + GUIDANCE_CHURN_BACKOFF_MS + 1);
		expect(later.id).toBe(true);
		expect((await admit(later.runId)).kind).toBe('admitted');
		expect(blocks()).toEqual([]);
	});

	it('refuses a bundle over the item cap for ten minutes', async () => {
		const insert = t.sqlite.prepare(
			`INSERT INTO context_item (id, user_id, kind, name, description, project_id, body, position, version, created_at, updated_at)
			VALUES (?, ?, 'prompt', ?, '', ?, 'x', ?, 1, ?, ?)`
		);
		for (let i = 0; i <= BUNDLE_ITEM_CAP; i++)
			insert.run(`ci_${i}`, USER, `p${i}`, PROJECT, i, NOW, NOW);
		const { runId } = await claim();
		expect(await admit(runId)).toEqual({
			kind: 'released',
			error: 'guidance bundle unavailable: item_cap'
		});
		expect(keys(runId)).toHaveLength(0);
		expect(blocks()).toMatchObject([
			{
				code: 'bundle_too_large',
				reason: 'item_cap',
				retry_after: NOW + GUIDANCE_REFUSAL_BACKOFF_MS
			}
		]);
	});

	it('stands down when another poll already took the flip', async () => {
		const { runId } = await claim();
		t.sqlite.prepare("UPDATE agent_run SET status = 'launching' WHERE id = ?").run(runId);
		expect(await admit(runId)).toEqual({ kind: 'lost' });
		expect(keys(runId)).toHaveLength(0);
		expect(blocks()).toEqual([]);
	});
});

describe('managed launch in a shared project', () => {
	const on = () => ({ ...t.env, SHARED_EXECUTION: 'on' }) as unknown as Env;
	const launch = (runId: string, adapter: ReturnType<typeof createFakeAdapter>) =>
		launchClaimedRun(t.db, on(), adapter, {
			userId: USER,
			runId,
			issueId: issue,
			projectId: PROJECT,
			runner: t.all('SELECT * FROM runner WHERE id = ?', runner)[0] as never,
			tier: 'balanced',
			model: null,
			now: NOW
		});

	it('hands the adapter the guarded material', async () => {
		await prompt('house-rules');
		const { runId } = await claim();
		const adapter = createFakeAdapter();
		expect(await launch(runId, adapter)).toBe('launched');
		const material = adapter.launches[0]!.material!;
		expect(material.launchPrompt).toContain('HOUSE-RULES');
		expect(material.context.env).toEqual([]);
		expect(material.digest).toMatch(/^[0-9a-f]{64}$/);
	});

	it('refuses an adapter that cannot take material, before any key exists', async () => {
		const { runId } = await claim();
		const adapter = { ...createFakeAdapter(), sharedMaterial: false };
		expect(await launch(runId, adapter)).toBe('launch_failed');
		expect(runRow(runId)).toMatchObject({
			status: 'failed',
			error: 'adapter does not support shared delivery'
		});
		expect(keys(runId)).toHaveLength(0);
	});

	it('keeps never-shared launches on the unguarded path', async () => {
		t.sqlite.prepare('UPDATE project SET shared_at = NULL WHERE id = ?').run(PROJECT);
		const { runId } = await claim();
		const adapter = createFakeAdapter();
		expect(await launch(runId, adapter)).toBe('launched');
		expect(adapter.launches[0]).not.toHaveProperty('material');
	});
});
