/**
 * The rules for editing a pack's context items through the ordinary context
 * API (docs/packs.md): an installed pack's items are read-only, and an
 * authored pack's items keep the scope their reach gives them. Placeholders
 * must name the pack's declared, non-secret inputs.
 */
import { scanPlaceholders, type ContextFile, type PackInputDecl } from '@tines/shared';
import { sql, type Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { ApiFail } from './core';
import { boundInput, parseInputDecls } from './pack-render';

export function packReadOnly(packName: string): ApiFail {
	return new ApiFail(
		403,
		'pack_read_only',
		`This belongs to the installed pack "${packName}" and is read-only. Add a project addition on the same state instead, or replace the pack with a new version.`,
		{ pack: packName }
	);
}

/** The pack an item or workflow belongs to, for guards. */
export async function loadPackForGuard(
	db: Kysely<Database>,
	packId: string
): Promise<{
	id: string;
	name: string;
	kind: 'authored' | 'installed';
	inputs: Record<string, PackInputDecl>;
}> {
	const pack = await db
		.selectFrom('pack')
		.select(['id', 'name', 'kind', 'inputs'])
		.where('id', '=', packId)
		.executeTakeFirst();
	if (!pack) throw new ApiFail(409, 'pack_missing', 'The pack this belongs to no longer exists');
	return { ...pack, inputs: parseInputDecls(pack.inputs) };
}

/**
 * Throws unless a pack item may be changed as `body` asks. Returns the pack's
 * input declarations (for placeholder checks), or null for an item outside
 * packs.
 */
export async function guardPackItemUpdate(
	db: Kysely<Database>,
	row: { pack_id?: string | null; kind: string; config: string | null },
	body: Record<string, unknown> | null
): Promise<Record<string, PackInputDecl> | null> {
	if (!row.pack_id) return null;
	const pack = await loadPackForGuard(db, row.pack_id);
	if (pack.kind === 'installed') throw packReadOnly(pack.name);
	if (!body) return pack.inputs;
	for (const field of ['project_id', 'workflow_state_id', 'issue_id', 'label_id'])
		if (body[field] !== undefined)
			throw new ApiFail(
				422,
				'pack_item_scope',
				"A pack item's scope is set by its reach in the pack; create it again at another reach instead",
				{ field }
			);
	if (row.kind === 'env' && body.secret === true)
		throw new ApiFail(
			422,
			'pack_secret_value',
			'A pack never holds secret values; declare a secret input and bind the variable to it',
			{ field: 'secret' }
		);
	if (boundInput(row) !== null) {
		const field = row.kind === 'env' ? 'value' : 'repo_url';
		if (body[field] !== undefined || (row.kind === 'repo' && body.repo_branch !== undefined))
			throw new ApiFail(
				422,
				'pack_item_bound',
				'This item takes its value from a pack input; change the input value on the pack instead',
				{ field }
			);
	}
	return pack.inputs;
}

/**
 * The inputs a pack item's text reads, validated against the declarations:
 * every placeholder must name a declared input that is not a secret.
 */
export function packInputRefs(
	inputs: Record<string, PackInputDecl>,
	texts: (string | null | undefined)[],
	bound: string | null
): string[] {
	const refs = new Set<string>();
	for (const text of texts) {
		if (!text) continue;
		for (const name of scanPlaceholders(text)) {
			const decl = inputs[name];
			if (!decl)
				throw new ApiFail(
					422,
					'unknown_input',
					`"{{ inputs.${name} }}" names no input of this pack`,
					{
						input: name
					}
				);
			if (decl.type === 'secret')
				throw new ApiFail(
					422,
					'secret_placeholder',
					`Secret input "${name}" cannot be used as a placeholder; bind an env variable to it instead`,
					{ input: name }
				);
			refs.add(name);
		}
	}
	if (bound) refs.add(bound);
	return [...refs];
}

/** The `.md` files of a skill: the only skill files placeholders render in. */
export function markdownTexts(files: ContextFile[] | undefined): string[] {
	return (files ?? []).filter((f) => f.path.toLowerCase().endsWith('.md')).map((f) => f.content);
}

/**
 * A pack's workflows are offered only in the pack's project (docs/packs.md):
 * refuses `workflow` for an issue, schedule or default in `projectId`.
 */
export function assertWorkflowInProject(
	workflow: { name: string; pack?: { project_id: string | null; name: string } | null },
	projectId: string | null,
	field = 'workflow_id'
): void {
	if (!workflow.pack || workflow.pack.project_id === projectId) return;
	throw new ApiFail(
		422,
		'workflow_not_in_project',
		`Workflow "${workflow.name}" comes from pack "${workflow.pack.name}" and is only available in that pack's project`,
		{ field }
	);
}

/**
 * A workflow is usable in a project when it is a system workflow, or belongs
 * to the project's organization — and, for a pack's workflow, to the pack's
 * project (docs/packs.md, docs/organizations.md). `target` is the project, or
 * the organization a project is being created in.
 */
export async function assertWorkflowIdInProject(
	db: Kysely<Database>,
	workflowId: string,
	target: string | { orgId: string } | null,
	field = 'workflow_id'
): Promise<void> {
	const row = await db
		.selectFrom('workflow')
		.leftJoin('pack', 'pack.id', 'workflow.pack_id')
		.select([
			'workflow.name',
			'workflow.user_id',
			'workflow.pack_id',
			'pack.project_id',
			'pack.name as pack_name',
			sql<string>`COALESCE(workflow.organization_id, 'org_' || workflow.user_id)`.as('org_id')
		])
		.where('workflow.id', '=', workflowId)
		.executeTakeFirst();
	if (!row || row.user_id === null) return;
	const projectId = typeof target === 'string' ? target : null;
	if (row.pack_id)
		assertWorkflowInProject(
			{ name: row.name, pack: { project_id: row.project_id, name: row.pack_name ?? '' } },
			projectId,
			field
		);
	const orgId =
		typeof target === 'string'
			? (
					await db
						.selectFrom('project')
						.select(sql<string>`COALESCE(organization_id, 'org_' || user_id)`.as('org'))
						.where('id', '=', target)
						.executeTakeFirst()
				)?.org
			: target?.orgId;
	if (orgId && row.org_id !== orgId)
		throw new ApiFail(
			422,
			'workflow_not_in_organization',
			`Workflow "${row.name}" belongs to another organization; copy it into this one to use it here`,
			{ field }
		);
}
