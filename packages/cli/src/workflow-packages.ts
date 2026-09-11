import { createInterface } from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import {
	ApiError,
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

export interface SavedWorkflowPackagePlan {
	format: 'tines.workflow-install-plan';
	version: 1;
	api_base: string;
	document_digest: string;
	plan: PrepareWorkflowPackageResponse;
}

export function readPackageSource(path: string): string {
	try {
		return readFileSync(path === PACKAGE_STDIN ? 0 : path, 'utf8');
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
	plan: PrepareWorkflowPackageResponse
): SavedWorkflowPackagePlan {
	const saved: SavedWorkflowPackagePlan = {
		format: 'tines.workflow-install-plan',
		version: 1,
		api_base: normalizeApiBase(apiBase),
		document_digest: plan.document_digest,
		plan
	};
	writeJsonFile(path, saved, { secret: true });
	return saved;
}

export function readWorkflowPackagePlan(path: string): SavedWorkflowPackagePlan {
	const saved = readStrictObject<Record<string, unknown>>(path, 'plan file');
	if (
		saved.format !== 'tines.workflow-install-plan' ||
		saved.version !== 1 ||
		typeof saved.api_base !== 'string' ||
		typeof saved.document_digest !== 'string' ||
		!saved.plan ||
		typeof saved.plan !== 'object' ||
		typeof (saved.plan as Record<string, unknown>).plan_token !== 'string' ||
		typeof (saved.plan as Record<string, unknown>).plan_digest !== 'string'
	) {
		throw new Error('invalid workflow package plan file');
	}
	return saved as unknown as SavedWorkflowPackagePlan;
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
			resolved.inputs.map(
				(input) =>
					`${input.input_id} (${input.type}, ${input.mode}): ${input.value}${input.id ? ` [${input.id}]` : ''}`
			)
		),
		'',
		...lines(
			'Original and rendered text:',
			resolved.patches.map(
				(patch) =>
					`${patch.record_id}.${patch.field}\n    original: ${patch.original}\n    rendered: ${patch.rendered}`
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
	const document = await parseLibraryV3Document(raw);
	if (document.profile !== 'workflow') throw new Error('expected a workflow-profile package');
	return { raw, document };
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
	try {
		return await api.getWorkflowPackageReceipt(plan.plan_id);
	} catch (error) {
		if (!(error instanceof ApiError) || error.status !== 404) throw error;
	}
	const request = {
		document_json: raw,
		plan_token: plan.plan_token,
		confirmation: { plan_digest: plan.plan_digest }
	};
	try {
		return await api.installWorkflowPackage(request);
	} catch (first) {
		try {
			return await api.getWorkflowPackageReceipt(plan.plan_id);
		} catch (recovery) {
			if (!(recovery instanceof ApiError) || recovery.status !== 404) throw first;
		}
		return api.installWorkflowPackage(request);
	}
}

export type { WorkflowPackageChoices, WorkflowPackageReceipt };
