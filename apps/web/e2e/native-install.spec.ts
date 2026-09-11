import { request as httpRequest } from 'node:http';
import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { unstable_dev, type Unstable_DevWorker } from 'wrangler';
import {
	LIBRARY_MAX_BYTES,
	type PrepareWorkflowPackageResponse,
	type WorkflowPackageDocument,
	type WorkflowPackageReceipt,
	withLibraryDocumentDigest
} from '@tines/shared';
import {
	automatedPackage,
	duplicateLibrary,
	inheritedPackage
} from '../../../packages/shared/src/library/fixtures';
import { signPackagePlan, verifyPackagePlan } from '../src/lib/server/library/token';
import { ALICE, BASE_URL } from './constants.mjs';
import { apiClient, body, errorBody, runId } from './helpers';

const SIGNING_KEY = 'e2e-only-secret-encryption-key';

/** Execute against the isolated database used by e2e/server.sh. */
function d1(sql: string): Array<Record<string, unknown>> {
	const output = execFileSync(
		'pnpm',
		[
			'exec',
			'wrangler',
			'd1',
			'execute',
			'tines',
			'--local',
			'--persist-to',
			'.wrangler-e2e',
			'--command',
			sql,
			'--json'
		],
		{ encoding: 'utf8' }
	);
	const result = JSON.parse(output) as Array<{ results?: Array<Record<string, unknown>> }>;
	return result[0]?.results ?? [];
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const ids = (values: string[]) => values.map(literal).join(',');

async function seal(document: WorkflowPackageDocument) {
	return JSON.stringify(await withLibraryDocumentDigest(document));
}

async function prepare(
	client: ReturnType<typeof apiClient>,
	documentJson: string,
	choices: Record<string, unknown>
) {
	return body<PrepareWorkflowPackageResponse>(
		await client.post('/api/v1/library/prepare', { document_json: documentJson, choices })
	);
}

async function automatedFixture(client: ReturnType<typeof apiClient>, marker: string) {
	const projectId = `prj_${marker}`;
	const runnerId = `rnr_${marker}`;
	const ruleId = `rul_base_${marker}`;
	const now = Date.now();
	d1(`INSERT INTO project(id,user_id,name,description,default_workflow_id,created_at,updated_at)
		VALUES(${literal(projectId)},${literal(ALICE.id)},${literal(`${marker} project`)},'', 'wf_standard',${now},${now});
		INSERT INTO runner(id,user_id,type,name,status,max_concurrent,max_run_minutes,default_tier,config,created_at,updated_at)
		VALUES(${literal(runnerId)},${literal(ALICE.id)},'local',${literal(`${marker} runner`)},'active',1,30,'balanced','{"harness":"codex"}',${now},${now});
		INSERT INTO routing_rule(id,user_id,project_id,workflow_state_id,label_id,targets,created_at,updated_at)
		VALUES(${literal(ruleId)},${literal(ALICE.id)},${literal(projectId)},NULL,NULL,${literal(JSON.stringify([{ runner_id: runnerId }]))},${now},${now})`);
	const document = automatedPackage();
	document.schedules[0].name = `${marker} schedule`;
	const documentJson = await seal(document);
	const plan = await prepare(client, documentJson, {
		inputs: {
			'input:1': { mode: 'create', name: `${marker}-label`, color: 'blue' },
			'input:2': { mode: 'reuse', id: projectId }
		},
		workflow_names: {
			'workflow:1': `${marker} main`,
			'workflow:2': `${marker} dependency`
		},
		schedule_ids: ['schedule:1'],
		routing: { 'routing:1': 'balanced' }
	});
	return { documentJson, plan, projectId, runnerId, ruleId };
}

function installBody(documentJson: string, plan: PrepareWorkflowPackageResponse) {
	return {
		document_json: documentJson,
		plan_token: plan.plan_token,
		confirmation: { plan_digest: plan.plan_digest }
	};
}

function allocated(plan: PrepareWorkflowPackageResponse) {
	return {
		workflows: ['workflow:1', 'workflow:2'].map((id) => plan.allocation.records[id].id),
		states: ['state:1', 'state:2', 'state:3'].map((id) => plan.allocation.records[id].id),
		transitions: [plan.allocation.records['transition:1'].id],
		context: ['context:1', 'context:2', 'context:3'].map((id) => plan.allocation.records[id].id),
		files: [plan.allocation.records['file:1'].id],
		labels: [plan.allocation.labels['input:1'].id],
		schedules: plan.allocation.records['schedule:1']
			? [plan.allocation.records['schedule:1'].id]
			: [],
		routing: plan.allocation.records['routing:1'] ? [plan.allocation.records['routing:1'].id] : [],
		events: [
			...['workflow:1', 'workflow:2', 'context:1', 'context:2', 'context:3']
				.map((id) => plan.allocation.records[id].event_id)
				.filter((id): id is string => id !== null),
			plan.allocation.labels['input:1'].event_id,
			plan.allocation.records['schedule:1']?.event_id,
			plan.allocation.records['routing:1']?.event_id
		].filter((id): id is string => !!id)
	};
}

function count(table: string, rowIds: string[]) {
	if (!rowIds.length) return 0;
	return d1(`SELECT COUNT(*) AS n FROM ${table} WHERE id IN (${ids(rowIds)})`)[0].n;
}

function expectNoInstallRows(plan: PrepareWorkflowPackageResponse) {
	const a = allocated(plan);
	expect(count('library_install', [plan.plan_id])).toBe(0);
	for (const [table, rowIds] of Object.entries({
		workflow: a.workflows,
		workflow_state: a.states,
		workflow_transition: a.transitions,
		context_item: a.context,
		context_item_file: a.files,
		label: a.labels,
		scheduled_task: a.schedules,
		routing_rule: a.routing,
		event: a.events
	}))
		expect(count(table, rowIds), table).toBe(0);
}

function auditReceipt(
	receipt: WorkflowPackageReceipt,
	plan: PrepareWorkflowPackageResponse,
	projectId: string
) {
	const a = allocated(plan);
	const stored = d1(
		`SELECT document_digest,plan_digest,receipt_json FROM library_install WHERE id=${literal(plan.plan_id)}`
	);
	expect(stored).toEqual([
		{
			document_digest: plan.document_digest,
			plan_digest: plan.plan_digest,
			receipt_json: JSON.stringify(receipt)
		}
	]);
	for (const [table, rowIds] of Object.entries({
		workflow: a.workflows,
		workflow_state: a.states,
		workflow_transition: a.transitions,
		context_item: a.context,
		context_item_file: a.files,
		label: a.labels,
		scheduled_task: a.schedules,
		routing_rule: a.routing,
		event: a.events
	}))
		expect(count(table, rowIds), table).toBe(rowIds.length);
	for (const object of receipt.objects) {
		const table = {
			workflow: 'workflow',
			state: 'workflow_state',
			transition: 'workflow_transition',
			prompt: 'context_item',
			skill: 'context_item',
			file: 'context_item_file',
			repo: 'context_item',
			label: 'label',
			schedule: 'scheduled_task',
			routing: 'routing_rule'
		}[object.kind];
		expect(table, object.kind).toBeTruthy();
		expect(d1(`SELECT id FROM ${table} WHERE id=${literal(object.id)}`)).toEqual([
			{ id: object.id }
		]);
	}
	const schedule = receipt.objects.find((object) => object.kind === 'schedule')!;
	const routing = receipt.objects.find((object) => object.kind === 'routing')!;
	expect(schedule).toMatchObject({
		id: a.schedules[0],
		name: plan.resolved.schedules[0].definition.name,
		href: `/projects/${projectId}?schedule=${a.schedules[0]}`
	});
	expect(routing).toMatchObject({ id: a.routing[0], name: 'balanced', href: '/agents#routing' });
	expect(
		d1(
			`SELECT enabled,last_run_at,run_count,project_id FROM scheduled_task WHERE id=${literal(a.schedules[0])}`
		)
	).toEqual([{ enabled: 0, last_run_at: null, run_count: 0, project_id: projectId }]);
	expect(
		d1(`SELECT inherits_from_state_id FROM workflow_state WHERE id=${literal(a.states[0])}`)
	).toEqual([{ inherits_from_state_id: a.states[2] }]);
}

function dropHttpResponse(path: string, payload: unknown): Promise<void> {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify(payload);
		const request = httpRequest(
			new URL(path, BASE_URL),
			{
				method: 'POST',
				headers: {
					authorization: `Bearer ${ALICE.apiKey}`,
					'content-type': 'application/json',
					'content-length': Buffer.byteLength(data)
				}
			},
			(response) => {
				response.destroy();
				resolve();
			}
		);
		request.on('error', (error) => {
			if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') resolve();
			else reject(error);
		});
		request.end(data, () => {
			request.destroy();
			resolve();
		});
	});
}

test.describe.serial('native D1 workflow install gate', () => {
	let probe: Unstable_DevWorker;

	test.beforeAll(async () => {
		probe = await unstable_dev('e2e/native-d1-probe.ts', {
			config: 'e2e/native-d1-probe.wrangler.jsonc',
			persistTo: '.wrangler-native-probe',
			logLevel: 'none',
			experimental: { disableExperimentalWarning: true, disableDevRegistry: true }
		});
	});

	test.afterAll(async () => {
		await probe.stop();
	});

	const probeQuery = async (sql: string, parameters: unknown[] = []) =>
		probe.fetch('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ sql, parameters })
		});

	test('measures native parameter, UTF-8 SQL, and stored-value limits', async () => {
		test.setTimeout(120_000);
		const parameterQuery = (n: number) =>
			`SELECT ${Array.from({ length: n }, (_, i) => `?${i + 1} AS p${i + 1}`).join(',')}`;
		for (const n of [90, 91, 100])
			expect((await probeQuery(parameterQuery(n), Array(n).fill(1))).status, `${n} params`).toBe(
				200
			);
		expect((await probeQuery(parameterQuery(101), Array(101).fill(1))).status).toBe(422);

		const sqlBytes = (n: number) => {
			const prefix = 'SELECT 1 /*';
			const suffix = '*/';
			return `${prefix}${'e'.repeat(n - prefix.length - suffix.length)}${suffix}`;
		};
		for (const n of [90 * 1024, 90 * 1024 + 1, 100_000])
			expect((await probeQuery(sqlBytes(n))).status, `${n} UTF-8 SQL bytes`).toBe(200);
		expect((await probeQuery(sqlBytes(100_001))).status).toBe(422);

		expect((await probeQuery('CREATE TABLE IF NOT EXISTS value_probe(v TEXT)')).status).toBe(200);
		for (const n of [1024 * 1024, 1024 * 1024 + 1, 2_000_000])
			expect(
				(await probeQuery('INSERT INTO value_probe(v) VALUES (?)', ['é'.repeat(n / 2)])).status,
				`${n} value bytes`
			).toBe(200);
		// Workerd's local D1 currently does not enforce the remote 2,000,000-byte
		// row/value cap. Keep that observation explicit instead of claiming that
		// Wrangler proves the hosted boundary; the app's 1 MiB margin is native-safe.
		expect(
			(await probeQuery('INSERT INTO value_probe(v) VALUES (?)', ['x'.repeat(2_000_001)])).status
		).toBe(200);
	});

	test('accepts exact document and record limits and rejects one over', async ({ request }) => {
		test.setTimeout(120_000);
		const client = apiClient(request, ALICE.apiKey);
		const documentDraft = inheritedPackage() as WorkflowPackageDocument & { digest?: string };
		delete documentDraft.digest;
		const small = JSON.stringify(documentDraft);
		const exactDocument = small + ' '.repeat(LIBRARY_MAX_BYTES - Buffer.byteLength(small));
		expect(Buffer.byteLength(exactDocument)).toBe(LIBRARY_MAX_BYTES);
		const exactResult = await body<{ valid: boolean; diagnostics: unknown[] }>(
			await client.post('/api/v1/library/validate', { document_json: exactDocument })
		);
		expect(exactResult, JSON.stringify(exactResult.diagnostics)).toMatchObject({ valid: true });
		expect(
			await body<{ valid: boolean; diagnostics: { code: string }[] }>(
				await client.post('/api/v1/library/validate', { document_json: exactDocument + ' ' })
			)
		).toMatchObject({ valid: false, diagnostics: [{ code: 'package_too_large' }] });

		const records = duplicateLibrary() as ReturnType<typeof duplicateLibrary> & { digest?: string };
		delete records.digest;
		const prompt = records.context.find((item) => item.kind === 'prompt')!;
		for (let i = 0; i < 990; i++)
			records.context.push({ ...prompt, id: `record:${runId}:${i}`, name: `record-${i}` });
		expect(
			await body<{ valid: boolean }>(
				await client.post('/api/v1/library/validate', { document_json: JSON.stringify(records) })
			)
		).toMatchObject({ valid: true });
		records.context.push({ ...prompt, id: `record:${runId}:over`, name: 'record-over' });
		expect(
			await body<{ valid: boolean; diagnostics: { code: string }[] }>(
				await client.post('/api/v1/library/validate', { document_json: JSON.stringify(records) })
			)
		).toMatchObject({ valid: false, diagnostics: [{ code: 'package_too_large' }] });
	});

	test('commits the exact 800-statement boundary once and rejects 801 before writes', async ({
		request
	}) => {
		test.setTimeout(120_000);
		const client = apiClient(request, ALICE.apiKey);
		const document = inheritedPackage();
		const source = document.context[0];
		if (source.kind !== 'prompt') throw new Error('expected prompt fixture');
		for (let i = 0; i < 390; i++)
			document.context.push({
				...source,
				id: `native-context-${runId}-${i}`,
				name: `native-${runId}-${i}`
			});
		const documentJson = await seal(document);
		const label = `native-boundary-${runId}`;
		const plan = await prepare(client, documentJson, {
			inputs: { 'input:1': { mode: 'create', name: label, color: 'blue' } },
			workflow_names: Object.fromEntries(
				document.workflows.map((workflow, index) => [
					workflow.id,
					`Native boundary ${runId} ${index}`
				])
			)
		});
		expect(plan.budget.statements).toBe(800);
		const receipt = await body<WorkflowPackageReceipt>(
			await client.post('/api/v1/library/install', installBody(documentJson, plan))
		);
		expect(receipt.id).toBe(plan.plan_id);
		expect(count('library_install', [plan.plan_id])).toBe(1);
		expect(
			d1(`SELECT COUNT(*) AS n FROM context_item WHERE name LIKE 'native-${runId}-%'`)
		).toEqual([{ n: 390 }]);

		const over = structuredClone(document);
		const skill = over.context.find((context) => context.kind === 'skill');
		if (!skill || skill.kind !== 'skill') throw new Error('expected skill fixture');
		skill.files.push({ id: `native-file-${runId}-over`, path: 'OVER.md', content: 'one over' });
		const rejected = await client.post('/api/v1/library/prepare', {
			document_json: await seal(over),
			choices: {
				inputs: {
					'input:1': { mode: 'create', name: `native-over-${runId}`, color: 'blue' }
				}
			}
		});
		expect(rejected.status()).toBe(422);
		expect(await errorBody(rejected)).toMatchObject({
			error: { code: 'package_too_large', details: { field: 'statements', actual: 801 } }
		});
		expect(d1(`SELECT COUNT(*) AS n FROM label WHERE name='native-over-${runId}'`)).toEqual([
			{ n: 0 }
		]);
	});

	test('persists a maximum-size skill payload exactly', async ({ request }) => {
		const client = apiClient(request, ALICE.apiKey);
		const document = inheritedPackage();
		const skill = document.context.find((item) => item.kind === 'skill');
		if (!skill || skill.kind !== 'skill') throw new Error('expected skill fixture');
		const contentBytes = 100 * 1024 - Buffer.byteLength(skill.files[0].path);
		skill.files[0].content = 'é'.repeat(contentBytes / 2);
		const documentJson = await seal(document);
		const marker = `native-file-${runId}`;
		const plan = await prepare(client, documentJson, {
			inputs: { 'input:1': { mode: 'create', name: marker, color: 'blue' } },
			workflow_names: { 'workflow:1': `${marker} main`, 'workflow:2': `${marker} dependency` }
		});
		await body(await client.post('/api/v1/library/install', installBody(documentJson, plan)));
		expect(
			d1(
				`SELECT length(CAST(content AS BLOB)) AS bytes FROM context_item_file WHERE id=${literal(plan.allocation.records['file:1'].id)}`
			)
		).toEqual([{ bytes: contentBytes }]);
	});

	test('rolls back every object, pointer, schedule, routing, and event family', async ({
		request
	}) => {
		test.setTimeout(300_000);
		const client = apiClient(request, ALICE.apiKey);
		const failures = [
			['workflow', 'INSERT'],
			['workflow_state', 'INSERT'],
			['workflow_transition', 'INSERT'],
			['context_item', 'INSERT'],
			['context_item_file', 'INSERT'],
			['workflow_state', 'UPDATE'],
			['label', 'INSERT'],
			['scheduled_task', 'INSERT'],
			['routing_rule', 'INSERT'],
			['event', 'INSERT']
		] as const;
		for (const [index, [table, operation]] of failures.entries()) {
			const marker = `nr-${runId}-${index}`;
			const fixture = await automatedFixture(client, marker);
			const beforeDefault = d1(
				`SELECT default_workflow_id FROM project WHERE id=${literal(fixture.projectId)}`
			);
			const beforeIssues = d1('SELECT COUNT(*) AS n FROM issue')[0].n;
			d1(`CREATE TRIGGER native_install_failure BEFORE ${operation} ON ${table}
				BEGIN SELECT RAISE(ABORT, 'native install injection'); END`);
			try {
				const failed = await client.post(
					'/api/v1/library/install',
					installBody(fixture.documentJson, fixture.plan)
				);
				expect(failed.status(), `${operation} ${table}`).toBeGreaterThanOrEqual(500);
			} finally {
				d1('DROP TRIGGER IF EXISTS native_install_failure');
			}
			expectNoInstallRows(fixture.plan);
			expect(
				d1(`SELECT default_workflow_id FROM project WHERE id=${literal(fixture.projectId)}`)
			).toEqual(beforeDefault);
			expect(d1('SELECT COUNT(*) AS n FROM issue')[0].n).toBe(beforeIssues);
		}
	});

	test('rejects inserted name, schedule, and routing competitors before writes', async ({
		request
	}) => {
		test.setTimeout(120_000);
		const client = apiClient(request, ALICE.apiKey);
		for (const family of ['name', 'schedule', 'routing'] as const) {
			const marker = `stale-${runId}-${family}`;
			const fixture = await automatedFixture(client, marker);
			if (family === 'name')
				d1(`INSERT INTO label(id,user_id,name,color,description,created_at,updated_at)
					VALUES(${literal(`lbl_race_${marker}`)},${literal(ALICE.id)},${literal(`${marker}-label`)},'blue','',1,1)`);
			if (family === 'schedule')
				d1(`INSERT INTO scheduled_task(id,project_id,name,title_template,description_template,workflow_id,cron,timezone,require_all_closed,enabled,next_run_at,run_count,created_at,updated_at)
					VALUES(${literal(`sch_race_${marker}`)},${literal(fixture.projectId)},${literal(`${marker} schedule`)},'','', 'wf_standard','0 9 * * 1','UTC',0,0,1,0,1,1)`);
			if (family === 'routing')
				d1(
					`UPDATE routing_rule SET targets=${literal(JSON.stringify([{ runner_id: fixture.runnerId, tier: 'fast' }]))},updated_at=updated_at+1 WHERE id=${literal(fixture.ruleId)}`
				);
			const failed = await client.post(
				'/api/v1/library/install',
				installBody(fixture.documentJson, fixture.plan)
			);
			expect(failed.status()).toBe(409);
			expect(await errorBody(failed)).toMatchObject({ error: { code: 'plan_stale' } });
			expectNoInstallRows(fixture.plan);
		}
	});

	test('rechecks expiry in D1 and an old receipt nonce cannot authorize children', async ({
		request
	}) => {
		test.setTimeout(120_000);
		const client = apiClient(request, ALICE.apiKey);
		const expiryFixture = await automatedFixture(client, `expiry-${runId}`);
		const payload = await verifyPackagePlan(expiryFixture.plan.plan_token, SIGNING_KEY);
		const remainingMs = 35;
		const issuedAt = Date.now() - (15 * 60_000 - remainingMs);
		const shortToken = await signPackagePlan(
			{ ...payload, issued_at: issuedAt, expires_at: issuedAt + 15 * 60_000 },
			SIGNING_KEY
		);
		const expired = await client.post('/api/v1/library/install', {
			...installBody(expiryFixture.documentJson, expiryFixture.plan),
			plan_token: shortToken
		});
		expect(expired.status()).toBe(409);
		expectNoInstallRows(expiryFixture.plan);

		const nonceFixture = await automatedFixture(client, `nonce-${runId}`);
		d1(`CREATE TRIGGER native_install_old_nonce AFTER INSERT ON library_install
			BEGIN UPDATE library_install SET execution_nonce='exe_old_nonce_value' WHERE id=NEW.id; END`);
		try {
			const stale = await client.post(
				'/api/v1/library/install',
				installBody(nonceFixture.documentJson, nonceFixture.plan)
			);
			expect(stale.status()).toBe(409);
		} finally {
			d1('DROP TRIGGER IF EXISTS native_install_old_nonce');
		}
		expect(count('library_install', [nonceFixture.plan.plan_id])).toBe(1);
		const rows = allocated(nonceFixture.plan);
		for (const [table, rowIds] of Object.entries({
			workflow: rows.workflows,
			workflow_state: rows.states,
			workflow_transition: rows.transitions,
			context_item: rows.context,
			context_item_file: rows.files,
			label: rows.labels,
			scheduled_task: rows.schedules,
			routing_rule: rows.routing,
			event: rows.events
		}))
			expect(count(table, rowIds), table).toBe(0);
	});

	test('makes true initial concurrent retries one-copy and recovers a dropped response', async ({
		request
	}) => {
		test.setTimeout(120_000);
		const client = apiClient(request, ALICE.apiKey);
		const concurrent = await automatedFixture(client, `concurrent-${runId}`);
		const beforeIssues = d1('SELECT COUNT(*) AS n FROM issue')[0].n;
		const beforeDefault = d1(
			`SELECT default_workflow_id FROM project WHERE id=${literal(concurrent.projectId)}`
		);
		const responses = await Promise.all([
			client.post('/api/v1/library/install', installBody(concurrent.documentJson, concurrent.plan)),
			client.post('/api/v1/library/install', installBody(concurrent.documentJson, concurrent.plan))
		]);
		const receipts = await Promise.all(
			responses.map((response) => body<WorkflowPackageReceipt>(response))
		);
		expect(receipts[1]).toEqual(receipts[0]);
		auditReceipt(receipts[0], concurrent.plan, concurrent.projectId);
		expect(d1('SELECT COUNT(*) AS n FROM issue')[0].n).toBe(beforeIssues);
		expect(
			d1(`SELECT default_workflow_id FROM project WHERE id=${literal(concurrent.projectId)}`)
		).toEqual(beforeDefault);

		const lost = await automatedFixture(client, `lost-${runId}`);
		await dropHttpResponse('/api/v1/library/install', installBody(lost.documentJson, lost.plan));
		await expect
			.poll(async () =>
				(await client.get(`/api/v1/library/installs/${lost.plan.plan_id}`)).status()
			)
			.toBe(200);
		const recovered = await body<WorkflowPackageReceipt>(
			await client.get(`/api/v1/library/installs/${lost.plan.plan_id}`)
		);
		const sequential = await body<WorkflowPackageReceipt>(
			await client.post('/api/v1/library/install', installBody(lost.documentJson, lost.plan))
		);
		expect(sequential).toEqual(recovered);
		auditReceipt(recovered, lost.plan, lost.projectId);
	});
});
