import { createInterface } from 'node:readline/promises';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
	ApiError,
	ApiNetworkError,
	canonicalizeLibraryValue,
	diagnosticOf,
	parseLibraryV3Document,
	parseStrictLibraryJson,
	type PrepareWorkflowPackageResponse,
	type ValidateLibraryResponse,
	type WorkflowPackageChoices,
	type WorkflowPackageDocument,
	type WorkflowPackageReceipt
} from '@tines/shared';
import { writeJsonFile } from './config.js';

export const PACKAGE_STDIN = '-';
const MAX_LOCAL_JSON_BYTES = 32 * 1024 * 1024;

export interface SavedWorkflowPackagePlan {
	format: 'tines.workflow-install-plan';
	version: 1;
	api_base: string;
	document_digest: string;
	remote_source?: { url: string; bytes_sha256: string };
	plan: PrepareWorkflowPackageResponse;
}

export function readPackageSource(path: string): string {
	try {
		const bytes = readFileSync(path === PACKAGE_STDIN ? 0 : path);
		if (bytes.byteLength > MAX_LOCAL_JSON_BYTES)
			throw new Error(`input exceeds ${MAX_LOCAL_JSON_BYTES} bytes`);
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch (error) {
		throw new Error(
			`cannot read ${path === PACKAGE_STDIN ? 'stdin' : path}: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

export function readStrictObject<T>(path: string, label: string): T {
	const value = parseStrictLibraryJson(readPackageSource(path));
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${label} must contain a JSON object`);
	}
	return value as T;
}

export function normalizeApiBase(value: string): string {
	return new URL(value).toString().replace(/\/$/, '');
}

export function saveWorkflowPackagePlan(
	path: string,
	apiBase: string,
	plan: PrepareWorkflowPackageResponse,
	remoteSource?: { url: string; bytes_sha256: string }
): SavedWorkflowPackagePlan {
	const saved: SavedWorkflowPackagePlan = {
		format: 'tines.workflow-install-plan',
		version: 1,
		api_base: normalizeApiBase(apiBase),
		document_digest: plan.document_digest,
		...(remoteSource ? { remote_source: remoteSource } : {}),
		plan
	};
	writeJsonFile(path, saved, { secret: true });
	return saved;
}

export function readWorkflowPackagePlan(path: string): SavedWorkflowPackagePlan {
	const saved = readStrictObject<Record<string, unknown>>(path, 'plan file');
	const outerKeys = ['format', 'version', 'api_base', 'document_digest', 'remote_source', 'plan'];
	const planKeys = [
		'operations',
		'document',
		'resolved',
		'allocation',
		'plan_id',
		'plan_digest',
		'document_digest',
		'issued_at',
		'expires_at',
		'actor_key',
		'compiler_version',
		'plan_token',
		'budget',
		'source'
	];
	if (
		![5, 6].includes(Object.keys(saved).length) ||
		!Object.keys(saved).every((key) => outerKeys.includes(key)) ||
		saved.format !== 'tines.workflow-install-plan' ||
		saved.version !== 1 ||
		typeof saved.api_base !== 'string' ||
		typeof saved.document_digest !== 'string' ||
		!saved.plan ||
		typeof saved.plan !== 'object' ||
		typeof (saved.plan as Record<string, unknown>).plan_token !== 'string' ||
		typeof (saved.plan as Record<string, unknown>).plan_digest !== 'string' ||
		![planKeys.length - 1, planKeys.length].includes(
			Object.keys(saved.plan as Record<string, unknown>).length
		) ||
		!Object.keys(saved.plan as Record<string, unknown>).every((key) => planKeys.includes(key))
	) {
		throw new Error('invalid workflow package plan file');
	}
	if (
		saved.remote_source !== undefined &&
		(!saved.remote_source ||
			typeof saved.remote_source !== 'object' ||
			Object.keys(saved.remote_source).length !== 2 ||
			typeof (saved.remote_source as Record<string, unknown>).url !== 'string' ||
			!/^sha256:[0-9a-f]{64}$/.test(
				String((saved.remote_source as Record<string, unknown>).bytes_sha256)
			))
	) {
		throw new Error('invalid workflow package plan file');
	}
	const result = saved as unknown as SavedWorkflowPackagePlan;
	assertPlanBinding(result.plan);
	return result;
}

function tokenPayload(token: string): Record<string, unknown> {
	const parts = token.split('.');
	if (
		token.length > 700_000 ||
		parts.length !== 3 ||
		parts[0] !== 'wip1' ||
		!parts.slice(1).every((part) => /^[A-Za-z0-9_-]+$/.test(part))
	)
		throw new Error('invalid workflow package plan token');
	try {
		const bytes = Buffer.from(parts[1], 'base64url');
		if (bytes.toString('base64url') !== parts[1]) throw new Error();
		const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
		return value as Record<string, unknown>;
	} catch {
		throw new Error('invalid workflow package plan token');
	}
}

export function expectedWorkflowPackageOperations(plan: PrepareWorkflowPackageResponse) {
	const operations = [];
	for (const workflow of plan.resolved.workflows) {
		const workflowId = plan.allocation.records[workflow.id]?.id;
		const href = `/workflows/${workflowId}`;
		operations.push({
			action: 'create',
			kind: 'workflow',
			local_id: workflow.id,
			id: workflowId,
			name: workflow.name,
			href,
			relationship: workflow.id === plan.document.main_workflow_id ? 'main' : 'dependency'
		});
		for (const state of workflow.states)
			operations.push({
				action: 'create',
				kind: 'state',
				local_id: state.id,
				id: plan.allocation.records[state.id]?.id,
				name: state.name,
				href: `${href}#state-${plan.allocation.records[state.id]?.id}`
			});
		for (const transition of workflow.transitions)
			operations.push({
				action: 'create',
				kind: 'transition',
				local_id: transition.id,
				id: plan.allocation.records[transition.id]?.id,
				name: transition.name,
				href
			});
	}
	for (const item of plan.resolved.context) {
		const workflow = plan.resolved.workflows.find((candidate) =>
			candidate.states.some((state) => state.id === item.state_id)
		);
		const href = `/context?workflow=${plan.allocation.records[workflow?.id ?? '']?.id}&q=${encodeURIComponent(item.name)}`;
		operations.push({
			action: 'create',
			kind: item.kind,
			local_id: item.id,
			id: plan.allocation.records[item.id]?.id,
			name: item.name,
			href
		});
		if (item.kind === 'skill')
			for (const file of item.files)
				operations.push({
					action: 'create',
					kind: 'file',
					local_id: file.id,
					id: plan.allocation.records[file.id]?.id,
					name: file.path,
					href
				});
	}
	for (const input of plan.resolved.inputs) {
		if (input.mode === 'create')
			operations.push({
				action: 'create',
				kind: 'label',
				local_id: input.input_id,
				id: input.id,
				name: input.value,
				href: '/labels'
			});
		if (input.mode === 'reuse')
			operations.push({
				action: 'reuse',
				kind: input.type,
				local_id: input.input_id,
				id: input.id,
				name: input.value,
				href:
					input.type === 'workflow'
						? `/workflows/${input.id}`
						: input.type === 'project'
							? `/projects/${input.id}`
							: '/labels'
			});
	}
	for (const skip of plan.resolved.skipped)
		operations.push({
			action: 'skip',
			kind: skip.kind,
			local_id: skip.local_id,
			id: null,
			name:
				skip.kind === 'schedule'
					? plan.document.schedules.find((item) => item.id === skip.local_id)?.name
					: plan.document.routing.find((item) => item.id === skip.local_id)?.tier,
			href: null
		});
	return operations;
}

export function assertPlanBinding(plan: PrepareWorkflowPackageResponse): void {
	const payload = tokenPayload(plan.plan_token);
	const { plan_digest: signedDigest, ...unsigned } = payload;
	const digest = `sha256:${createHash('sha256')
		.update(canonicalizeLibraryValue({ plan: unsigned, resolved: plan.resolved }))
		.digest('hex')}`;
	const mirrors = {
		id: plan.plan_id,
		plan_digest: plan.plan_digest,
		document_digest: plan.document_digest,
		issued_at: plan.issued_at,
		expires_at: plan.expires_at,
		actor_key: plan.actor_key,
		compiler_version: plan.compiler_version,
		allocation: plan.allocation,
		budget: plan.budget,
		...(plan.source ? { source: plan.source } : {})
	};
	for (const [field, value] of Object.entries(mirrors)) {
		const signedField = field === 'id' ? 'id' : field;
		if (canonicalizeLibraryValue(payload[signedField]) !== canonicalizeLibraryValue(value))
			throw new Error(`saved workflow package plan has modified ${field}`);
	}
	if (signedDigest !== digest || plan.plan_digest !== digest)
		throw new Error('saved workflow package plan digest does not bind its review');
	if (
		canonicalizeLibraryValue(plan.operations) !==
		canonicalizeLibraryValue(expectedWorkflowPackageOperations(plan))
	)
		throw new Error('saved workflow package plan has modified operations');
}

const lines = (heading: string, values: string[]) =>
	values.length ? [heading, ...values.map((value) => `  ${value}`)] : [heading, '  none'];

export function formatWorkflowPackageReview(plan: PrepareWorkflowPackageResponse): string {
	const { document, resolved } = plan;
	const output = [
		`Workflow package plan ${plan.plan_digest}`,
		`  file: ${plan.document_digest}`,
		`  valid until: ${new Date(plan.expires_at).toISOString()}`,
		`  budget: ${plan.budget.statements} statements, ${plan.budget.max_parameters} parameters, ${plan.budget.max_sql_bytes} SQL bytes, ${plan.budget.max_value_bytes} value bytes`,
		'',
		...lines(
			'Operations:',
			plan.operations.map(
				(operation) =>
					`${operation.action} ${operation.kind} ${operation.local_id}: ${operation.name}${operation.relationship ? ` (${operation.relationship})` : ''}${operation.id ? ` [${operation.id}]` : ''}`
			)
		),
		'',
		...lines(
			'Workflows and gates:',
			document.workflows.flatMap((workflow) => [
				`${workflow.id}: ${resolved.names[workflow.id] ?? workflow.name} — ${workflow.description}`,
				...workflow.states.map(
					(state) =>
						`  state ${state.id}: ${state.name} (${state.category})${state.inherits_from ? ` inherits ${state.inherits_from.state_id}` : ''}`
				),
				...workflow.transitions.map(
					(transition) =>
						`  transition ${transition.id}: ${transition.name} ${transition.from_state_id} -> ${transition.to_state_id}; gates ${transition.requires.length ? transition.requires.map((gate) => `${gate.artifact}${gate.type ? `:${gate.type}` : ''}${gate.content_type ? `:${gate.content_type}` : ''}`).join(', ') : 'none'}`
				)
			])
		),
		'',
		...lines(
			'Inputs:',
			document.inputs.map((declaration) => {
				const input = resolved.inputs.find((candidate) => candidate.input_id === declaration.id);
				return `${declaration.id} ${declaration.key}: ${declaration.label} — ${declaration.description}\n    type: ${declaration.type}; required: ${declaration.required ? 'yes' : 'no'}; default: ${declaration.default ?? 'none'}; required states: ${declaration.required_states?.join(', ') || 'none'}\n    resolution: ${input?.mode ?? 'missing'}; value: ${input?.value ?? 'missing'}${input?.id ? ` [${input.id}]` : ''}`;
			})
		),
		'',
		...lines(
			'Original and rendered text:',
			resolved.patches.map(
				(patch) =>
					`${patch.record_id}.${patch.field}\n    original: ${patch.original}\n    rendered: ${patch.rendered}\n    uses: ${patch.uses.length ? patch.uses.map((use) => `${use.id} -> ${use.input_id} (${use.count} occurrence${use.count === 1 ? '' : 's'})`).join(', ') : 'none'}`
			)
		),
		'',
		...lines(
			'Context:',
			document.context.flatMap((item) => {
				const header = `${item.kind} ${item.id} in ${item.state_id}: ${item.name} — ${item.description}`;
				if (item.kind === 'prompt') return [header, `  body: ${item.body}`];
				if (item.kind === 'repo')
					return [
						header,
						`  repository: ${item.repo_url}; branch ${item.repo_branch ?? 'default'}; directory ${item.repo_dir ?? 'default'}`
					];
				return [
					header,
					...item.files.map((file) => `  file ${file.id} ${file.path}:\n${file.content}`)
				];
			})
		),
		'',
		...lines(
			'Schedules:',
			resolved.schedules.map(
				(schedule) =>
					`${schedule.local_id}: ${resolved.names[schedule.local_id] ?? schedule.definition.name}; project ${schedule.project_id}; ${JSON.stringify(schedule.definition)}`
			)
		),
		'',
		...lines(
			'Routing capabilities:',
			resolved.routing.flatMap((routing) => [
				`${routing.local_id}: ${routing.tier}; winning rule ${routing.winning_rule_id}`,
				...routing.targets.map(
					(target) =>
						`  ${target.name} (${target.status}) ${target.model ?? 'default model'} / ${target.config}; supported ${target.supported ? 'yes' : 'no'}`
				),
				...routing.warnings.map((warning) => `  warning: ${warning}`)
			])
		),
		'',
		...lines(
			'Skipped:',
			resolved.skipped.map((item) => `${item.kind} ${item.local_id}`)
		)
	];
	return output.join('\n');
}

export function formatValidation(result: ValidateLibraryResponse): string {
	const output = [result.valid ? 'valid workflow package' : 'invalid workflow package'];
	if (result.digest) output.push(`digest: ${result.digest}`);
	for (const diagnostic of result.diagnostics) {
		output.push(`${diagnostic.path || '/'}: ${diagnostic.code}: ${diagnostic.message}`);
	}
	output.push(
		`limits: ${result.limits.max_document_bytes} bytes, ${result.limits.max_records} records, depth ${result.limits.max_depth}`
	);
	return output.join('\n');
}

export async function localDocument(
	path: string
): Promise<{ raw: string; document: WorkflowPackageDocument }> {
	const raw = readPackageSource(path);
	return packageDocument(raw);
}

export async function packageDocument(
	raw: string
): Promise<{ raw: string; document: WorkflowPackageDocument }> {
	const document = await parseLibraryV3Document(raw);
	if (document.profile !== 'workflow') throw new Error('expected a workflow-profile package');
	return { raw, document };
}

export function workflowPackageBytesSha256(raw: string): string {
	return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

export function canonicalWorkflowPackage(document: WorkflowPackageDocument): string {
	return canonicalizeLibraryValue(document);
}

export function validationFailure(error: unknown): ValidateLibraryResponse {
	return {
		valid: false,
		digest: null,
		diagnostics: diagnosticOf(error),
		limits: { max_document_bytes: 5 * 1024 * 1024, max_records: 1000, max_depth: 64 }
	};
}

export async function askToInstall(plan: PrepareWorkflowPackageResponse): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		process.stderr.write(`${formatWorkflowPackageReview(plan)}\n`);
		const answer = await rl
			.question(`Install exactly plan ${plan.plan_digest}? [y/N] `)
			.catch(() => '');
		return /^y(es)?$/i.test(answer.trim());
	} finally {
		rl.close();
	}
}

export async function recoverOrInstall(
	api: {
		getWorkflowPackageReceipt(id: string): Promise<WorkflowPackageReceipt>;
		installWorkflowPackage(body: {
			document_json: string;
			plan_token: string;
			confirmation: { plan_digest: string };
		}): Promise<WorkflowPackageReceipt>;
	},
	raw: string,
	plan: PrepareWorkflowPackageResponse
): Promise<WorkflowPackageReceipt> {
	const checked = (receipt: WorkflowPackageReceipt) => {
		if (
			receipt.id !== plan.plan_id ||
			receipt.document_digest !== plan.document_digest ||
			receipt.plan_digest !== plan.plan_digest
		)
			throw new Error('recovered workflow package receipt does not match the saved plan');
		return receipt;
	};
	try {
		return checked(await api.getWorkflowPackageReceipt(plan.plan_id));
	} catch (error) {
		if (!(error instanceof ApiError) || error.status !== 404) throw error;
	}
	const request = {
		document_json: raw,
		plan_token: plan.plan_token,
		confirmation: { plan_digest: plan.plan_digest }
	};
	try {
		return checked(await api.installWorkflowPackage(request));
	} catch (first) {
		// A structured server refusal is certain and retrying it can never help.
		// Only a transport failure leaves the commit outcome unknown.
		if (!(first instanceof ApiNetworkError)) throw first;
		try {
			return checked(await api.getWorkflowPackageReceipt(plan.plan_id));
		} catch (recovery) {
			if (!(recovery instanceof ApiError) || recovery.status !== 404) throw first;
		}
		return checked(await api.installWorkflowPackage(request));
	}
}

export type { WorkflowPackageChoices, WorkflowPackageReceipt };
