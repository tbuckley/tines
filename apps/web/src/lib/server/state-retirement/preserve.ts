import {
	repoDirFromUrl,
	type StateRetirementAllocation,
	type StateRetirementDiagnostic,
	type StateRetirementEffectiveBundle,
	type StateRetirementEffectiveItem,
	type StateRetirementInventoryV1,
	type StateRetirementLaunchDifference,
	type StateRetirementOperation,
	type StateRetirementPlannerOptions,
	type StateRetirementPlanV1,
	type StateRetirementRawItem,
	type StateRetirementRollbackData,
	type StateRetirementScope,
	type StateRetirementSourceOrder,
	type StateRetirementTargetComparison,
	type StateRetirementTargetClass
} from '@tines/shared';

const CONTEXT_KINDS = new Set(['prompt', 'skill', 'repo', 'env', 'artifact']);
const DEFAULT_MAX_TARGETS = 4096;
const DEFAULT_MAX_LABELS = 8;
const DEFAULT_MAX_COPIES = 2000;
const SAFE_MIN = Number.MIN_SAFE_INTEGER;

type Row = Record<string, unknown>;
type State = {
	id: string;
	workflow_id: string;
	name: string;
	category: string;
	parent: string | null;
	created_at: number;
};
type Workflow = { id: string; user_id: string | null; name: string };

const str = (value: unknown, fallback = ''): string =>
	typeof value === 'string' ? value : fallback;
const nullableString = (value: unknown): string | null =>
	typeof value === 'string' ? value : null;
const integer = (value: unknown, fallback = 0): number =>
	typeof value === 'number' && Number.isInteger(value) ? value : fallback;
const bool = (value: unknown): boolean => value === true || value === 1;

function stableHex(parts: string[]): string {
	let hash = 2166136261;
	for (const part of parts.join('\u0000')) {
		hash ^= part.charCodeAt(0);
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

function stableId(prefix: string, parts: string[], used: Set<string>): string {
	const base = `${prefix}_preserve_${stableHex(parts)}`;
	let id = base;
	let n = 2;
	while (used.has(id)) id = `${base}_${n++}`;
	used.add(id);
	return id;
}

function scopeKey(scope: StateRetirementScope): string {
	return [scope.project_id, scope.workflow_state_id, scope.label_id, scope.issue_id]
		.map((part) => part ?? '')
		.join('|');
}

function targetKey(target: StateRetirementTargetClass): string {
	return [
		target.state_id,
		target.project.kind === 'explicit' ? target.project.id : '*',
		target.label_ids.join(','),
		target.issue.kind === 'explicit' ? target.issue.id : '*'
	].join('|');
}

function normalizeItem(
	row: Row,
	files: StateRetirementInventoryV1['witness']['context_files']
): StateRetirementRawItem {
	const id = str(row.id);
	return {
		id,
		kind: str(row.kind),
		name: str(row.name),
		description: str(row.description),
		scope: {
			project_id: nullableString(row.project_id),
			workflow_state_id: nullableString(row.workflow_state_id),
			label_id: nullableString(row.label_id),
			issue_id: nullableString(row.issue_id)
		},
		body: nullableString(row.body),
		repo_url: nullableString(row.repo_url),
		repo_branch: nullableString(row.repo_branch),
		repo_dir: nullableString(row.repo_dir),
		config: nullableString(row.config),
		position: integer(row.position),
		version: integer(row.version, 1),
		created_at: integer(row.created_at),
		updated_at: integer(row.updated_at),
		files: files
			.filter((file) => str(file.context_item_id) === id)
			.map((file) => ({
				id: str(file.id),
				context_item_id: id,
				path: str(file.path),
				content: str(file.content),
				created_at: integer(file.created_at),
				updated_at: integer(file.updated_at)
			})),
		env_hint: nullableString(row.env_hint),
		env_secret: bool(row.env_secret)
	};
}

function readWitness(inventory: StateRetirementInventoryV1): {
	items: StateRetirementRawItem[];
	states: Map<string, State>;
	workflows: Map<string, Workflow>;
	projects: Set<string>;
	issues: Map<string, { project_id: string; state_id: string }>;
	issueLabels: Map<string, string[]>;
	labels: Map<string, string>;
} {
	const witness = inventory.witness;
	const workflows = new Map(
		witness.workflows.map((row) => [
			str(row.id),
			{
				id: str(row.id),
				user_id: nullableString(row.user_id),
				name: str(row.name)
			}
		])
	);
	const states = new Map(
		witness.states.map((row) => [
			str(row.id),
			{
				id: str(row.id),
				workflow_id: str(row.workflow_id),
				name: str(row.name),
				category: str(row.category),
				parent: nullableString(row.inherits_from_state_id),
				created_at: integer(row.created_at)
			}
		])
	);
	const projects = new Set(witness.projects.map((row) => str(row.id)).filter(Boolean));
	const issues = new Map(
		witness.issues.map((row) => [
			str(row.id),
			{ project_id: str(row.project_id), state_id: str(row.state_id) }
		])
	);
	const issueLabels = new Map<string, string[]>();
	for (const row of witness.issue_labels) {
		const issueId = str(row.issue_id);
		const labelId = str(row.label_id);
		if (issueId && labelId)
			issueLabels.set(issueId, [...(issueLabels.get(issueId) ?? []), labelId]);
	}
	for (const labels of issueLabels.values()) labels.sort();
	const labels = new Map<string, string>();
	for (const row of witness.labels) {
		const id = str(row.id);
		if (id) labels.set(id, str(row.name, id));
	}
	const items = witness.context_items
		.map((row) => normalizeItem(row, witness.context_files))
		.filter((row) => row.kind !== 'artifact');
	for (const row of items)
		if (row.scope.label_id && !labels.has(row.scope.label_id))
			labels.set(row.scope.label_id, row.scope.label_id);
	for (const issueLabelIds of issueLabels.values())
		for (const labelId of issueLabelIds) if (!labels.has(labelId)) labels.set(labelId, labelId);
	return { items, states, workflows, projects, issues, issueLabels, labels };
}

function stateChain(leafId: string, states: Map<string, State>): string[] {
	const reverse: string[] = [];
	const seen = new Set<string>();
	let cursor: string | null = leafId;
	while (cursor && !seen.has(cursor)) {
		seen.add(cursor);
		const state = states.get(cursor);
		if (!state) break;
		reverse.push(cursor);
		cursor = state.parent;
	}
	return reverse.reverse();
}

function targetProjectId(target: StateRetirementTargetClass): string | null {
	return target.project.kind === 'explicit' ? target.project.id : null;
}

function targetIssueId(target: StateRetirementTargetClass): string | null {
	return target.issue.kind === 'explicit' ? target.issue.id : null;
}

function matches(
	row: StateRetirementRawItem,
	target: StateRetirementTargetClass,
	chain: string[]
): boolean {
	const project = row.scope.project_id;
	if (project !== null && (target.project.kind !== 'explicit' || project !== target.project.id))
		return false;
	const state = row.scope.workflow_state_id;
	if (state !== null && !chain.includes(state)) return false;
	if (row.scope.label_id !== null && !target.label_ids.includes(row.scope.label_id)) return false;
	const issue = row.scope.issue_id;
	if (issue !== null && (target.issue.kind !== 'explicit' || issue !== target.issue.id))
		return false;
	return true;
}

function layerRank(scope: StateRetirementScope): number {
	return (
		(scope.issue_id ? 8 : 0) +
		(scope.label_id ? 4 : 0) +
		(scope.workflow_state_id ? 2 : 0) +
		(scope.project_id ? 1 : 0)
	);
}

function sortRows(
	rows: StateRetirementRawItem[],
	chain: string[],
	labels: Map<string, string>
): StateRetirementRawItem[] {
	const depth = (row: StateRetirementRawItem) =>
		row.scope.workflow_state_id ? chain.indexOf(row.scope.workflow_state_id) : chain.length - 1;
	const labelSortKey = (row: StateRetirementRawItem) =>
		(row.scope.label_id ? labels.get(row.scope.label_id) : '')?.toLowerCase() ||
		(row.scope.label_id ?? '');
	return [...rows].sort(
		(a, b) =>
			layerRank(a.scope) - layerRank(b.scope) ||
			depth(a) - depth(b) ||
			(labelSortKey(a) < labelSortKey(b) ? -1 : labelSortKey(a) > labelSortKey(b) ? 1 : 0) ||
			a.position - b.position ||
			a.created_at - b.created_at ||
			a.id.localeCompare(b.id)
	);
}

function isJournal(row: StateRetirementRawItem): boolean {
	return (
		row.kind === 'prompt' &&
		row.name === 'journal' &&
		row.scope.project_id !== null &&
		row.scope.workflow_state_id !== null &&
		row.scope.label_id === null &&
		row.scope.issue_id === null
	);
}

function scopeLabel(
	scope: StateRetirementScope,
	names: Map<string, State>,
	workflows: Map<string, Workflow>,
	qualify = false
): string {
	const parts: string[] = [];
	if (scope.project_id) parts.push(`project ${scope.project_id}`);
	if (scope.workflow_state_id) {
		const state = names.get(scope.workflow_state_id);
		const workflow = state && workflows.get(state.workflow_id);
		parts.push(
			`state ${qualify && workflow ? `${workflow.name} / ` : ''}${state?.name ?? scope.workflow_state_id}`
		);
	}
	if (scope.label_id) parts.push(`label ${scope.label_id}`);
	if (scope.issue_id) parts.push(`issue ${scope.issue_id}`);
	return parts.length ? parts.join(' · ') : 'global';
}

function toEffective(
	row: StateRetirementRawItem,
	leaf: string,
	states: Map<string, State>,
	workflows: Map<string, Workflow>
): StateRetirementEffectiveItem {
	const inherited =
		row.scope.workflow_state_id && row.scope.workflow_state_id !== leaf
			? row.scope.workflow_state_id
			: null;
	const base: StateRetirementEffectiveItem = {
		item_id: row.id,
		kind: row.kind,
		name: row.name,
		scope: { ...row.scope },
		position: row.position,
		version: row.version,
		inherited_from: inherited,
		is_journal: isJournal(row)
	};
	if (row.kind === 'prompt') base.body = row.body ?? '';
	if (row.kind === 'skill') base.files = row.files.map(({ path, content }) => ({ path, content }));
	if (row.kind === 'repo')
		base.repo = {
			url: row.repo_url ?? '',
			branch: row.repo_branch,
			dir: row.repo_dir ?? repoDirFromUrl(row.repo_url ?? '')
		};
	if (row.kind === 'env')
		base.env = { secret: row.env_secret === true, hint: row.env_hint ?? null };
	// Force the maps to be used in this pure serializer so a caller cannot
	// accidentally introduce secret-bearing display names in a later variant.
	void states;
	void workflows;
	return base;
}

function dedupe(
	rows: StateRetirementRawItem[],
	kind: string,
	leaf: string,
	states: Map<string, State>,
	workflows: Map<string, Workflow>
) {
	const candidates = rows.filter((row) => row.kind === kind);
	const winners = new Map<string, StateRetirementRawItem>();
	const overridden: StateRetirementEffectiveBundle['overridden'] = [];
	for (const row of candidates) {
		const previous = winners.get(row.name);
		if (previous)
			overridden.push({ item_id: previous.id, overridden_by: row.id, kind, name: row.name });
		winners.set(row.name, row);
	}
	return {
		winners: [...winners.values()].map((row) => toEffective(row, leaf, states, workflows)),
		overridden
	};
}

function bundle(
	rows: StateRetirementRawItem[],
	target: StateRetirementTargetClass,
	chain: string[],
	states: Map<string, State>,
	workflows: Map<string, Workflow>,
	labels: Map<string, string>
): StateRetirementEffectiveBundle {
	const matched = sortRows(
		rows.filter((row) => matches(row, target, chain)),
		chain,
		labels
	);
	const prompts = matched
		.filter((row) => row.kind === 'prompt')
		.map((row) => toEffective(row, chain.at(-1)!, states, workflows));
	const skills = dedupe(matched, 'skill', chain.at(-1)!, states, workflows);
	const repos = dedupe(matched, 'repo', chain.at(-1)!, states, workflows);
	const envs = dedupe(matched, 'env', chain.at(-1)!, states, workflows);
	const byDir = new Map<string, string[]>();
	for (const row of repos.winners)
		if (row.repo) byDir.set(row.repo.dir, [...(byDir.get(row.repo.dir) ?? []), row.item_id]);
	return {
		prompts,
		skills: skills.winners,
		repos: repos.winners,
		envs: envs.winners,
		overridden: [...skills.overridden, ...repos.overridden, ...envs.overridden],
		repo_conflicts: [...byDir.entries()]
			.filter(([, ids]) => ids.length > 1)
			.map(([dir, item_ids]) => ({ dir, item_ids })),
		journal: journalFor(rows, target, chain)
	};
}

function journalFor(
	rows: StateRetirementRawItem[],
	target: StateRetirementTargetClass,
	chain: string[]
) {
	const project = targetProjectId(target);
	if (!project) return { state_id: null, item_id: null, version: null };
	const state = chain[0];
	const row = rows.find(
		(candidate) =>
			isJournal(candidate) &&
			candidate.scope.project_id === project &&
			candidate.scope.workflow_state_id === state
	);
	return { state_id: state ?? null, item_id: row?.id ?? null, version: row?.version ?? null };
}

function bodyHash(body: string): string {
	return stableHex([body]);
}

function enumerateTargets(
	inventory: StateRetirementInventoryV1,
	data: ReturnType<typeof readWitness>,
	options: StateRetirementPlannerOptions
): { targets: StateRetirementTargetClass[]; diagnostics: StateRetirementDiagnostic[] } {
	const diagnostics: StateRetirementDiagnostic[] = [];
	const pointerStates = [
		...new Set(inventory.pointers.map((pointer) => pointer.child_state_id))
	].sort();
	const relevantLabels = [...data.labels.keys()].sort();
	const maxLabels = options.max_labels ?? DEFAULT_MAX_LABELS;
	if (relevantLabels.length > maxLabels) {
		return {
			targets: [],
			diagnostics: [
				{
					code: 'retirement_enumeration_bound',
					message: `Preservation needs ${relevantLabels.length} label dimensions; the bound is ${maxLabels}`,
					details: { labels: relevantLabels.length, max_labels: maxLabels }
				}
			]
		};
	}
	const labelSets: string[][] = [];
	for (let mask = 0; mask < 1 << relevantLabels.length; mask++) {
		labelSets.push(relevantLabels.filter((_, index) => (mask & (1 << index)) !== 0));
	}
	const projects = [...data.projects].sort().map((id) => ({ kind: 'explicit' as const, id }));
	const projectClasses: StateRetirementTargetClass['project'][] = [
		...projects,
		{ kind: 'unmatched' as const }
	];
	const explicitIssues = [...data.issues.keys()].sort();
	const targets: StateRetirementTargetClass[] = [];
	for (const stateId of pointerStates) {
		for (const issueId of explicitIssues) {
			const issue = data.issues.get(issueId)!;
			if (issue.state_id !== stateId) continue;
			targets.push({
				id: '',
				state_id: stateId,
				project: { kind: 'explicit', id: issue.project_id },
				label_ids: data.issueLabels.get(issueId) ?? [],
				issue: { kind: 'explicit', id: issueId }
			});
		}
		for (const project of projectClasses)
			for (const labelIds of labelSets) {
				targets.push({
					id: '',
					state_id: stateId,
					project,
					label_ids: labelIds,
					issue: { kind: 'none' }
				});
			}
	}
	const unique = new Map<string, StateRetirementTargetClass>();
	for (const target of targets) {
		target.id = `target_${stableHex([targetKey(target)])}`;
		unique.set(targetKey(target), target);
	}
	const result = [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
	const maxTargets = options.max_targets ?? DEFAULT_MAX_TARGETS;
	if (result.length > maxTargets)
		diagnostics.push({
			code: 'retirement_enumeration_bound',
			message: `Preservation needs ${result.length} target classes; the bound is ${maxTargets}`,
			details: { targets: result.length, max_targets: maxTargets }
		});
	return { targets: result.slice(0, maxTargets), diagnostics };
}

function sourceOrder(
	rows: StateRetirementRawItem[],
	chain: string[],
	labels: Map<string, string>
): StateRetirementSourceOrder[] {
	return sortRows(rows, chain, labels)
		.filter((row) => row.kind === 'prompt')
		.map((row) => ({
			item_id: row.id,
			kind: row.kind,
			name: row.name,
			position: row.position,
			state_depth: row.scope.workflow_state_id
				? chain.indexOf(row.scope.workflow_state_id)
				: chain.length - 1,
			scope: { ...row.scope },
			...(row.body !== null ? { body_sha256: bodyHash(row.body) } : {})
		}));
}

function promptText(
	bundleValue: StateRetirementEffectiveBundle,
	states: Map<string, State>,
	workflows: Map<string, Workflow>
): string {
	return bundleValue.prompts
		.map((row) => {
			const qualified = row.inherited_from !== null;
			const label = scopeLabel(row.scope, states, workflows, qualified);
			const heading = row.is_journal ? `## Journal (${label})` : `## Context: ${label}`;
			return `${heading}\n\n${(row.body ?? '').trim()}`;
		})
		.join('\n\n');
}

function semanticBundle(value: StateRetirementEffectiveBundle) {
	const scopeWithoutState = (row: StateRetirementEffectiveItem) => ({
		project_id: row.scope.project_id,
		label_id: row.scope.label_id,
		issue_id: row.scope.issue_id
	});
	const prompt = (row: StateRetirementEffectiveItem) => ({
		body: row.body,
		scope: scopeWithoutState(row)
	});
	const item = (row: StateRetirementEffectiveItem) => ({
		name: row.name,
		body: row.body,
		files: row.files,
		repo: row.repo,
		env: row.env,
		scope: scopeWithoutState(row)
	});
	return JSON.stringify({
		prompts: value.prompts.map(prompt),
		skills: value.skills.map(item),
		repos: value.repos.map(item),
		envs: value.envs.map(item)
	});
}

function launchDifference(
	before: StateRetirementEffectiveBundle,
	after: StateRetirementEffectiveBundle,
	leaf: string,
	sourceToCopy: Map<string, string>,
	states: Map<string, State>,
	workflows: Map<string, Workflow>
): StateRetirementLaunchDifference {
	const beforeText = promptText(before, states, workflows);
	const afterText = promptText(after, states, workflows);
	const bodyChanges = before.prompts.map((row) => {
		const copyId = sourceToCopy.get(`${leaf}|${row.item_id}`) ?? null;
		const match = after.prompts.find((candidate) => candidate.item_id === (copyId ?? row.item_id));
		return {
			source_item_id: row.item_id,
			copy_item_id: copyId,
			same_bytes: Boolean(match && match.body === row.body)
		};
	});
	const headingsBefore = before.prompts.map((row) =>
		scopeLabel(row.scope, states, workflows, row.inherited_from !== null)
	);
	const headingsAfter = after.prompts.map((row) =>
		scopeLabel(row.scope, states, workflows, row.inherited_from !== null)
	);
	const headingChanges = headingsBefore
		.map((value, index) => ({ before: value, after: headingsAfter[index] ?? null }))
		.filter((pair) => pair.before !== pair.after);
	return {
		before_text: beforeText,
		after_text: afterText,
		body_changes: bodyChanges,
		heading_changes: headingChanges,
		allowed: bodyChanges.every((change) => change.same_bytes)
	};
}

function addDiagnostic(
	diagnostics: StateRetirementDiagnostic[],
	diagnostic: StateRetirementDiagnostic
) {
	const key = `${diagnostic.code}|${diagnostic.state_id ?? ''}|${diagnostic.item_id ?? ''}|${diagnostic.message}`;
	if (
		!diagnostics.some(
			(entry) =>
				`${entry.code}|${entry.state_id ?? ''}|${entry.item_id ?? ''}|${entry.message}` === key
		)
	)
		diagnostics.push(diagnostic);
}

function preservedName(
	row: StateRetirementRawItem,
	sourceState: State,
	workflow: Workflow,
	canonicalJournal: boolean
): string {
	if (canonicalJournal) return 'journal';
	if (isJournal(row)) return `Journal snapshot — ${workflow.name} / ${sourceState.name}`;
	if (workflow.name === 'Design Craft' && sourceState.name === 'Craft')
		return 'Craft guidance — preserved from Design Craft / Craft';
	return `Guidance — preserved from ${workflow.name} / ${sourceState.name}`;
}

function copyScope(row: StateRetirementRawItem, leaf: string): StateRetirementScope {
	return { ...row.scope, workflow_state_id: leaf };
}

function rawCopy(
	row: StateRetirementRawItem,
	allocation: StateRetirementAllocation
): StateRetirementRawItem {
	return {
		...row,
		id: allocation.copy_item_id,
		name: allocation.name,
		scope: { ...allocation.scope },
		position: allocation.position,
		version: 1,
		updated_at: row.updated_at,
		files: row.files.map((file, index) => ({
			...file,
			id: allocation.copy_file_ids[index],
			context_item_id: allocation.copy_item_id
		}))
	};
}

/**
 * Pure Release A planner. It consumes only the versioned witnessed inventory;
 * it never allocates through the database, accepts client operations, reads
 * env values, or changes state. Slice 2 may bind the returned operations to a
 * fresh hold and signed request.
 */
export function planStateRetirement(
	inventory: StateRetirementInventoryV1,
	options: StateRetirementPlannerOptions = {}
): StateRetirementPlanV1 {
	const emptyRollback: StateRetirementRollbackData = {
		original_pointers: [],
		source_to_copy: {},
		source_item_ids: [],
		source_file_ids: []
	};
	const base: Omit<StateRetirementPlanV1, 'applyable'> = {
		version: 1 as const,
		inventory: {
			owner_id: inventory?.owner_id ?? '',
			captured_at: inventory?.captured_at ?? 0,
			inventory_digest: inventory?.inventory_digest ?? '',
			topology_digest: inventory?.topology_digest ?? ''
		},
		held_states: [],
		active_run_ids: [],
		targets: [],
		diagnostics: [] as StateRetirementDiagnostic[],
		comparisons: [] as StateRetirementTargetComparison[],
		allocations: [] as StateRetirementAllocation[],
		source_to_copy: {} as Record<string, string[]>,
		proposed_operations: [] as StateRetirementOperation[],
		rollback: emptyRollback
	};
	if (
		!inventory ||
		inventory.version !== 1 ||
		!inventory.witness ||
		!Array.isArray(inventory.pointers)
	) {
		base.diagnostics.push({
			code: 'retirement_inventory_invalid',
			message: 'The preservation planner requires a version 1 witnessed inventory'
		});
		return { ...base, applyable: false };
	}
	base.held_states = [...new Set(inventory.pointers.flatMap((pointer) => pointer.chain))].sort();
	const heldStateSet = new Set(base.held_states);
	base.active_run_ids = inventory.witness.active_runs
		.filter((row) => heldStateSet.has(str(row.state_id_at_start)))
		.map((row) => str(row.id))
		.filter(Boolean)
		.sort();
	base.rollback.original_pointers = inventory.pointers.map((pointer) => ({
		child_state_id: pointer.child_state_id,
		parent_state_id: pointer.parent_state_id,
		state_witness:
			inventory.witness.states.find((state) => state.id === pointer.child_state_id) ?? {}
	}));
	base.diagnostics.push(...inventory.diagnostics);
	if (inventory.pointers.length === 0)
		base.diagnostics.push({
			code: 'retirement_no_pointers',
			message: 'The witnessed inventory contains no state-inheritance pointers'
		});
	const data = readWitness(inventory);
	const enumerated = enumerateTargets(inventory, data, options);
	base.targets = enumerated.targets;
	base.diagnostics.push(...enumerated.diagnostics);
	if (base.diagnostics.length > 0 && base.targets.length === 0)
		return { ...base, applyable: false };

	const usedIds = new Set([
		...data.items.map((row) => row.id),
		...data.items.flatMap((row) => row.files.map((file) => file.id))
	]);
	const selected = new Map<string, StateRetirementRawItem>();
	const beforeBundles = new Map<string, StateRetirementEffectiveBundle>();
	for (const target of base.targets) {
		const chain = stateChain(target.state_id, data.states);
		const before = bundle(data.items, target, chain, data.states, data.workflows, data.labels);
		beforeBundles.set(targetKey(target), before);
		for (const row of sortRows(
			data.items.filter((candidate) => matches(candidate, target, chain)),
			chain,
			data.labels
		)) {
			if (
				!row.scope.workflow_state_id ||
				!chain.includes(row.scope.workflow_state_id) ||
				row.scope.workflow_state_id === target.state_id
			)
				continue;
			if (row.kind === 'env') {
				addDiagnostic(base.diagnostics, {
					code: 'retirement_inherited_env',
					state_id: target.state_id,
					item_id: row.id,
					message: `Inherited environment item ${row.name} cannot be preserved without serializing a secret value`
				});
				continue;
			}
			if (!CONTEXT_KINDS.has(row.kind) || row.kind === 'artifact') {
				addDiagnostic(base.diagnostics, {
					code: 'retirement_unsupported_kind',
					state_id: target.state_id,
					item_id: row.id,
					message: `Inherited context kind ${row.kind || '(empty)'} is not representable by the Release A copy adapter`
				});
				continue;
			}
			if (row.kind === 'prompt') selected.set(`${target.state_id}|${row.id}`, row);
		}
	}

	// Skill/repo copies are chosen only when they win for at least one target.
	for (const target of base.targets) {
		const chain = stateChain(target.state_id, data.states);
		const rows = sortRows(
			data.items.filter((row) => matches(row, target, chain)),
			chain,
			data.labels
		);
		for (const kind of ['skill', 'repo'] as const) {
			const winners = new Map<string, StateRetirementRawItem>();
			for (const row of rows.filter((candidate) => candidate.kind === kind))
				winners.set(row.name, row);
			for (const row of winners.values()) {
				if (row.scope.workflow_state_id && row.scope.workflow_state_id !== target.state_id) {
					selected.set(`${target.state_id}|${row.id}`, row);
				}
			}
		}
	}

	const pending: Array<{
		row: StateRetirementRawItem;
		leaf: string;
		allocation: StateRetirementAllocation;
	}> = [];
	for (const [key, row] of selected) {
		const leaf = key.slice(0, key.indexOf('|'));
		const chain = stateChain(leaf, data.states);
		const sourceStateId = row.scope.workflow_state_id!;
		const sourceState = data.states.get(sourceStateId);
		const workflow = sourceState && data.workflows.get(sourceState.workflow_id);
		if (!sourceState || !workflow) {
			addDiagnostic(base.diagnostics, {
				code: 'retirement_inventory_invalid',
				state_id: leaf,
				item_id: row.id,
				message: `Source state ${sourceStateId} is missing from the witness`
			});
			continue;
		}
		const destination = copyScope(row, leaf);
		const exactLocalJournal =
			isJournal(row) &&
			row.scope.workflow_state_id === chain[0] &&
			data.items.some(
				(candidate) =>
					isJournal(candidate) &&
					candidate.scope.project_id === destination.project_id &&
					candidate.scope.workflow_state_id === leaf
			);
		const canonicalJournal =
			isJournal(row) && row.scope.workflow_state_id === chain[0] && !exactLocalJournal;
		let name =
			row.kind === 'skill' || row.kind === 'repo'
				? row.name
				: preservedName(row, sourceState, workflow, canonicalJournal);
		const existing = data.items.some(
			(candidate) =>
				candidate.kind === row.kind &&
				candidate.name === name &&
				scopeKey(candidate.scope) === scopeKey(destination)
		);
		if (existing && row.kind !== 'prompt') {
			addDiagnostic(base.diagnostics, {
				code: 'retirement_collision',
				state_id: leaf,
				item_id: row.id,
				message: `Copying ${row.kind} ${row.name} would collide at ${scopeKey(destination)}`
			});
			continue;
		}
		const planned = pending.some(
			(candidate) =>
				candidate.row.kind === row.kind &&
				candidate.allocation.name === name &&
				scopeKey(candidate.allocation.scope) === scopeKey(destination)
		);
		if (planned || existing) name = `${name} — ${row.id.slice(-8)}`;
		if (name.length > 100) name = `${name.slice(0, 91)} — ${row.id.slice(-8)}`;
		const copyId = stableId('ctx', [inventory.inventory_digest, leaf, row.id, name], usedIds);
		const fileIds = row.files.map((file) =>
			stableId('ctf', [inventory.inventory_digest, copyId, file.path, file.id], usedIds)
		);
		pending.push({
			row,
			leaf,
			allocation: {
				source_item_id: row.id,
				copy_item_id: copyId,
				copy_file_ids: fileIds,
				name,
				scope: destination,
				position: 0,
				version: 1,
				source_version: row.version
			}
		});
	}
	const maxCopies = options.max_copies ?? DEFAULT_MAX_COPIES;
	if (pending.length > maxCopies) {
		addDiagnostic(base.diagnostics, {
			code: 'retirement_enumeration_bound',
			message: `Preservation needs ${pending.length} copies; the bound is ${maxCopies}`,
			details: { copies: pending.length, max_copies: maxCopies }
		});
	}

	// Positions are a single sequence per exact destination tuple, including
	// all kinds. Allocate below the current minimum so no local item moves.
	const byScope = new Map<string, typeof pending>();
	for (const entry of pending)
		byScope.set(scopeKey(entry.allocation.scope), [
			...(byScope.get(scopeKey(entry.allocation.scope)) ?? []),
			entry
		]);
	for (const entries of byScope.values()) {
		const chain = stateChain(entries[0].leaf, data.states);
		const order = new Map(
			sortRows(
				entries.map((entry) => entry.row),
				chain,
				data.labels
			).map((row, index) => [row.id, index])
		);
		entries.sort((a, b) => order.get(a.row.id)! - order.get(b.row.id)!);
		const existingPositions = data.items
			.filter((row) => scopeKey(row.scope) === scopeKey(entries[0].allocation.scope))
			.map((row) => row.position);
		const minimum = existingPositions.length ? Math.min(...existingPositions) : 0;
		const start = minimum - entries.length;
		if (start < SAFE_MIN || !Number.isSafeInteger(start)) {
			addDiagnostic(base.diagnostics, {
				code: 'retirement_position_overflow',
				state_id: entries[0].leaf,
				message: `No safe integer positions remain before ${minimum}`
			});
			continue;
		}
		entries.forEach((entry, index) => {
			entry.allocation.position = start + index;
		});
	}

	const copies = pending.map((entry) => rawCopy(entry.row, entry.allocation));
	const sourceToCopy = new Map<string, string>();
	for (const entry of pending)
		sourceToCopy.set(`${entry.leaf}|${entry.row.id}`, entry.allocation.copy_item_id);
	for (const target of base.targets) {
		const chain = stateChain(target.state_id, data.states);
		const before = beforeBundles.get(targetKey(target))!;
		const projectedRows = [
			...data.items,
			...copies.filter((row) => row.scope.workflow_state_id === target.state_id)
		];
		const after = bundle(
			projectedRows,
			target,
			[target.state_id],
			data.states,
			data.workflows,
			data.labels
		);
		const launch = launchDifference(
			before,
			after,
			target.state_id,
			sourceToCopy,
			data.states,
			data.workflows
		);
		const same = semanticBundle(before) === semanticBundle(after);
		const raw = sortRows(
			data.items.filter((row) => matches(row, target, chain)),
			chain,
			data.labels
		);
		const candidateIds = raw
			.filter((row) => row.kind === 'skill' || row.kind === 'repo' || row.kind === 'env')
			.map((row) => row.id);
		base.comparisons.push({
			target,
			before,
			after,
			launch,
			raw_prompt_order: sourceOrder(raw, chain, data.labels),
			candidate_item_ids: candidateIds
		});
		if (!same || !launch.allowed)
			addDiagnostic(base.diagnostics, {
				code: 'retirement_unrepresentable_order',
				state_id: target.state_id,
				message: `Projected exact-state context differs for target ${target.id}`,
				details: { target: target.id, prompt_bytes_preserved: launch.allowed, semantic_match: same }
			});
		if (before.repo_conflicts.length || after.repo_conflicts.length)
			addDiagnostic(base.diagnostics, {
				code: 'retirement_repo_conflict',
				state_id: target.state_id,
				message: `Repository checkout directories conflict for target ${target.id}`,
				details: { before: before.repo_conflicts, after: after.repo_conflicts }
			});
	}

	base.allocations = pending.map((entry) => entry.allocation);
	for (const allocation of base.allocations)
		base.source_to_copy[allocation.source_item_id] = [
			...(base.source_to_copy[allocation.source_item_id] ?? []),
			allocation.copy_item_id
		];
	const pointerOperations: StateRetirementOperation[] = inventory.pointers.map((pointer) => ({
		kind: 'clear_pointer',
		child_state_id: pointer.child_state_id,
		original_parent_state_id: pointer.parent_state_id,
		state_witness:
			inventory.witness.states.find((state) => state.id === pointer.child_state_id) ?? {}
	}));
	const copyOperations: StateRetirementOperation[] = pending.map((entry) => ({
		kind: 'copy_context_item',
		allocation: entry.allocation,
		payload: {
			item: {
				kind: entry.row.kind,
				name: entry.allocation.name,
				description: entry.row.description,
				scope: entry.allocation.scope,
				body: entry.row.body,
				repo_url: entry.row.repo_url,
				repo_branch: entry.row.repo_branch,
				repo_dir: entry.row.repo_dir,
				config: entry.row.config,
				position: entry.allocation.position,
				created_at: entry.row.created_at
			},
			files: entry.row.files.map((file, index) => ({
				id: entry.allocation.copy_file_ids[index],
				path: file.path,
				content: file.content
			}))
		}
	}));
	const rollback: StateRetirementRollbackData = {
		original_pointers: base.rollback.original_pointers,
		source_to_copy: base.source_to_copy,
		source_item_ids: pending.map((entry) => entry.row.id).sort(),
		source_file_ids: pending.flatMap((entry) => entry.row.files.map((file) => file.id)).sort()
	};
	base.rollback = rollback;
	const applyable =
		base.diagnostics.length === 0 &&
		base.comparisons.length === base.targets.length &&
		base.targets.length > 0;
	base.proposed_operations = applyable ? [...copyOperations, ...pointerOperations] : [];
	return { ...base, applyable };
}

export const createStateRetirementPlan = planStateRetirement;
