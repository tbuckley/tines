/** Validating and writing a project's input values and a person's own secret values. */
import { ENV_VALUE_MAX_BYTES, type PackInputDecl, type PackInputValueInput } from '@tines/shared';
import type { CompiledQuery, Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import { encryptSecret } from '../../crypto';
import { ApiFail } from '../core';
import { encryptionKeyOr503 } from '../context';
import { assertWorkflowIdInProject } from '../pack-items';

export interface ValueRow {
	name: string;
	text_value: string | null;
	repo_url: string | null;
	repo_branch: string | null;
	workflow_id: string | null;
	state_id: string | null;
}

/** This pack's own workflows by key (ids may be about to be written). */
export type PackWorkflowKeys = Map<string, { id: string; states: Map<string, string> }>;

function fail(input: string, message: string): never {
	throw new ApiFail(422, 'invalid_input_value', message, { input });
}

/**
 * Validates `values` against the declarations. A workflow value may name a
 * workflow of this pack as `pack:<workflow>` or `pack:<workflow>/<state>`
 * (its ids may not exist until the same batch writes them), or any workflow
 * this project can use, by id. `null` clears a value.
 */
export async function resolveValues(
	db: Kysely<Database>,
	ownerId: string,
	projectId: string,
	decls: Record<string, PackInputDecl>,
	values: Record<string, PackInputValueInput | null> | undefined,
	packWorkflows: PackWorkflowKeys
): Promise<{ upserts: ValueRow[]; clears: string[] }> {
	const upserts: ValueRow[] = [];
	const clears: string[] = [];
	for (const [name, raw] of Object.entries(values ?? {})) {
		const decl = decls[name];
		if (!decl)
			throw new ApiFail(422, 'unknown_input', `This pack declares no input "${name}"`, {
				input: name
			});
		if (raw === null) {
			clears.push(name);
			continue;
		}
		if (typeof raw !== 'object') fail(name, `The value for "${name}" must be an object`);
		const row: ValueRow = {
			name,
			text_value: null,
			repo_url: null,
			repo_branch: null,
			workflow_id: null,
			state_id: null
		};
		switch (decl.type) {
			case 'secret':
				fail(name, `"${name}" is a secret input: each person sets their own value (my_secrets)`);
				break;
			case 'text':
				if (typeof raw.text !== 'string') fail(name, `"${name}" needs a "text" value`);
				if (raw.text.length > 10_000) fail(name, `"${name}" is longer than 10,000 characters`);
				row.text_value = raw.text;
				break;
			case 'repo': {
				const url = typeof raw.repo_url === 'string' ? raw.repo_url.trim() : '';
				let parsed: URL | null = null;
				try {
					parsed = new URL(url);
				} catch {
					parsed = null;
				}
				if (!parsed || parsed.protocol !== 'https:' || url.length > 1000)
					fail(name, `"${name}" needs an https repository URL`);
				const branch =
					typeof raw.repo_branch === 'string' && raw.repo_branch.trim()
						? raw.repo_branch.trim().slice(0, 200)
						: (decl.default_branch ?? null);
				row.repo_url = url;
				row.repo_branch = branch;
				break;
			}
			case 'workflow': {
				const ref = typeof raw.workflow_id === 'string' ? raw.workflow_id.trim() : '';
				if (!ref) fail(name, `"${name}" needs a "workflow_id"`);
				if (ref.startsWith('pack:')) {
					const [wfKey, stateKey] = ref.slice(5).split('/');
					const wf = packWorkflows.get(wfKey);
					if (!wf) fail(name, `This pack has no workflow "${wfKey}"`);
					row.workflow_id = wf.id;
					if (stateKey) {
						const st = wf.states.get(stateKey);
						if (!st) fail(name, `Workflow "${wfKey}" has no state "${stateKey}"`);
						row.state_id = st;
					}
				} else {
					const wf = await db
						.selectFrom('workflow')
						.leftJoin('pack', 'pack.id', 'workflow.pack_id')
						.select([
							'workflow.id',
							'workflow.name',
							'workflow.pack_id',
							'pack.project_id',
							'pack.name as pack_name'
						])
						.where('workflow.id', '=', ref)
						.where((eb) =>
							eb.or([eb('workflow.user_id', '=', ownerId), eb('workflow.user_id', 'is', null)])
						)
						.executeTakeFirst();
					if (!wf) fail(name, `Workflow "${ref}" does not exist`);
					await assertWorkflowIdInProject(db, wf.id, projectId, name);
					row.workflow_id = wf.id;
					if (typeof raw.state_id === 'string' && raw.state_id) {
						const st = await db
							.selectFrom('workflow_state')
							.select('id')
							.where('id', '=', raw.state_id)
							.where('workflow_id', '=', wf.id)
							.executeTakeFirst();
						if (!st) fail(name, `State "${raw.state_id}" is not in workflow "${wf.name}"`);
						row.state_id = st.id;
					}
				}
				break;
			}
		}
		upserts.push(row);
	}
	return { upserts, clears };
}

export function valueWriteQueries(
	db: Kysely<Database>,
	packId: string,
	resolved: { upserts: ValueRow[]; clears: string[] },
	now: number
): CompiledQuery[] {
	const out: CompiledQuery[] = [];
	for (const name of resolved.clears)
		out.push(
			db
				.deleteFrom('pack_input_value')
				.where('pack_id', '=', packId)
				.where('name', '=', name)
				.compile()
		);
	for (const row of resolved.upserts)
		out.push(
			db
				.insertInto('pack_input_value')
				.values({ pack_id: packId, ...row, updated_at: now })
				.onConflict((oc) =>
					oc.columns(['pack_id', 'name']).doUpdateSet({
						text_value: row.text_value,
						repo_url: row.repo_url,
						repo_branch: row.repo_branch,
						workflow_id: row.workflow_id,
						state_id: row.state_id,
						updated_at: now
					})
				)
				.compile()
		);
	return out;
}

/** The person's own values for secret inputs; `null` or '' removes theirs. */
export async function secretWriteQueries(
	db: Kysely<Database>,
	env: Env,
	packId: string,
	userId: string,
	decls: Record<string, PackInputDecl>,
	secrets: Record<string, string | null> | undefined,
	now: number
): Promise<CompiledQuery[]> {
	const out: CompiledQuery[] = [];
	for (const [name, value] of Object.entries(secrets ?? {})) {
		if (decls[name]?.type !== 'secret')
			throw new ApiFail(422, 'unknown_input', `This pack declares no secret input "${name}"`, {
				input: name
			});
		const remove = db
			.deleteFrom('contributor_secret')
			.where('user_id', '=', userId)
			.where('pack_id', '=', packId)
			.where('input_name', '=', name)
			.compile();
		if (value === null || value === '') {
			out.push(remove);
			continue;
		}
		if (typeof value !== 'string' || new TextEncoder().encode(value).length > ENV_VALUE_MAX_BYTES)
			throw new ApiFail(
				422,
				'invalid_input_value',
				`The value for "${name}" must be text of at most 16 KiB`,
				{
					input: name
				}
			);
		const enc = await encryptSecret(value, encryptionKeyOr503(env));
		out.push(remove);
		out.push(
			db
				.insertInto('contributor_secret')
				.values({
					id: newId('csec'),
					user_id: userId,
					pack_id: packId,
					input_name: name,
					value_enc: enc,
					hint: null,
					updated_at: now
				})
				.compile()
		);
	}
	return out;
}
