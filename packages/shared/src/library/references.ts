import { inputToken, renderDeclaredTokens } from './inputs.js';
import { validateLibraryV3Shape, invalid, pointer } from './schema.js';
import {
	LIBRARY_V3_MAX_RECORDS,
	type PortableLibraryV3Document,
	type WorkflowPackageDocument,
	type LibraryV3Workflow,
	type SystemStateRef
} from './types.js';

/** Validates every edge after deep shape checking, including unused optional records. */
export function validateLibraryV3References(document: PortableLibraryV3Document): void {
	validateLibraryV3Shape(document);
	const ids = new Map<string, string>();
	let count = 0;
	const add = (id: string, path: string) => {
		count++;
		if (count > LIBRARY_V3_MAX_RECORDS)
			invalid(path, 'package_too_large', `Package exceeds ${LIBRARY_V3_MAX_RECORDS} records`);
		if (ids.has(id)) invalid(path, 'duplicate_local_id', `Local ID already used at ${ids.get(id)}`);
		ids.set(id, path);
	};
	const unique = (values: string[], path: string, code: string) => {
		if (new Set(values).size !== values.length) invalid(path, code, 'Values must be unique');
	};
	const workflows = new Map(document.workflows.map((w) => [w.id, w]));
	const states = new Map<
		string,
		{ state: LibraryV3Workflow['states'][number]; workflow: string; path: string }
	>();
	const fields = new Map<string, Record<string, string>>();
	const requireRef = (
		exists: boolean,
		path: string,
		message = 'Reference does not identify the required record kind'
	) => {
		if (!exists) invalid(path, 'invalid_reference', message);
	};
	const system = (ref: SystemStateRef, path: string) => {
		requireRef(
			['Open', 'Human Review', 'Closed'].includes(ref.state_name),
			path,
			'Unknown Standard state'
		);
	};
	for (const [wi, w] of document.workflows.entries()) {
		const p = `/workflows/${wi}`;
		add(w.id, `${p}/id`);
		fields.set(w.id, { description: w.description });
		if (!w.states.length)
			invalid(`${p}/states`, 'no_states', 'A workflow needs at least one state');
		unique(
			w.states.map((s) => s.name.trim()),
			`${p}/states`,
			'duplicate_state_name'
		);
		for (const [si, s] of w.states.entries()) {
			const sp = `${p}/states/${si}`;
			add(s.id, `${sp}/id`);
			states.set(s.id, { state: s, workflow: w.id, path: sp });
		}
		const local = new Map(w.states.map((s) => [s.id, s]));
		const initial = local.get(w.initial_state_id);
		requireRef(!!initial, `${p}/initial_state_id`, 'Initial state must belong to its workflow');
		if (initial && initial.category !== 'backlog' && initial.category !== 'active')
			invalid(
				`${p}/initial_state_id`,
				'invalid_initial_state',
				'Initial state must be backlog or active'
			);
		unique(
			w.transitions.map((t) => `${t.from_state_id}\0${t.name.trim().toLowerCase()}`),
			`${p}/transitions`,
			'duplicate_action'
		);
		for (const [ti, t] of w.transitions.entries()) {
			const tp = `${p}/transitions/${ti}`;
			add(t.id, `${tp}/id`);
			requireRef(local.has(t.from_state_id), `${tp}/from_state_id`);
			requireRef(local.has(t.to_state_id), `${tp}/to_state_id`);
			if (t.from_state_id === t.to_state_id)
				invalid(tp, 'self_transition', 'Self transitions are not allowed');
			unique(
				t.requires.map((r) => r.artifact),
				`${tp}/requires`,
				'duplicate_requirement'
			);
		}
	}
	for (const { state, path } of states.values()) {
		const ref = state.inherits_from;
		if (ref?.kind === 'bundled_state')
			requireRef(states.has(ref.state_id), `${path}/inherits_from`);
		else if (ref?.kind === 'system_state') system(ref, `${path}/inherits_from`);
	}
	for (const entry of states.values()) {
		const chain = new Set<string>();
		let current: typeof entry | undefined = entry;
		let length = 0;
		while (current) {
			if (chain.has(current.state.id))
				invalid(
					`${entry.path}/inherits_from`,
					'inheritance_cycle',
					'State inheritance contains a cycle'
				);
			chain.add(current.state.id);
			length++;
			const ref: typeof current.state.inherits_from = current.state.inherits_from;
			if (ref?.kind === 'system_state') length++;
			if (length > 3)
				invalid(
					`${entry.path}/inherits_from`,
					'inheritance_depth',
					'Inheritance may contain at most three states'
				);
			current = ref?.kind === 'bundled_state' ? states.get(ref.state_id) : undefined;
		}
	}
	const contextKeys = new Set<string>();
	for (const [ci, item] of document.context.entries()) {
		const p = `/context/${ci}`;
		add(item.id, `${p}/id`);
		fields.set(item.id, {
			description: item.description,
			...(item.kind === 'prompt' ? { body: item.body } : {})
		});
		let scope: string;
		if ('state_id' in item) {
			requireRef(states.has(item.state_id), `${p}/state_id`);
			scope = item.state_id;
		} else {
			const ref = item.scope.state;
			if (ref?.kind === 'bundled_state') requireRef(states.has(ref.state_id), `${p}/scope/state`);
			if (ref?.kind === 'system_state') system(ref, `${p}/scope/state`);
			if (document.profile !== 'library')
				invalid(p, 'invalid_scope', 'Package context must have exact state scope');
			if (item.scope.project_id)
				requireRef(
					document.projects.some((r) => r.id === item.scope.project_id),
					`${p}/scope/project_id`
				);
			if (item.scope.label_id)
				requireRef(
					document.labels.some((r) => r.id === item.scope.label_id),
					`${p}/scope/label_id`
				);
			scope = JSON.stringify([
				item.scope.project_id ?? null,
				ref?.kind === 'bundled_state'
					? ['bundled', ref.state_id]
					: ref
						? ['system', ref.state_name]
						: null,
				item.scope.label_id ?? null
			]);
		}
		const key = JSON.stringify([scope, item.kind, item.name.trim()]);
		if (contextKeys.has(key))
			invalid(p, 'duplicate_context', 'Context kind/name must be unique at its exact scope');
		contextKeys.add(key);
		if (item.kind === 'skill')
			for (const [fi, file] of item.files.entries()) {
				add(file.id, `${p}/files/${fi}/id`);
				fields.set(file.id, { content: file.content });
			}
	}
	if (document.profile === 'library') {
		for (const [i, p] of document.projects.entries()) {
			add(p.id, `/projects/${i}/id`);
			if (p.default_workflow?.kind === 'bundled_workflow')
				requireRef(
					workflows.has(p.default_workflow.workflow_id),
					`/projects/${i}/default_workflow`
				);
		}
		for (const [i, label] of document.labels.entries()) add(label.id, `/labels/${i}/id`);
		unique(
			document.projects.map((p) => p.name.trim()),
			'/projects',
			'duplicate_project'
		);
		unique(
			document.labels.map((l) => l.name.trim().toLowerCase()),
			'/labels',
			'duplicate_label'
		);
		return;
	}
	requireRef(
		workflows.has(document.main_workflow_id),
		'/main_workflow_id',
		'Main workflow does not exist'
	);
	const reached = new Set<string>();
	const pending = [document.main_workflow_id];
	while (pending.length) {
		const id = pending.pop()!;
		if (reached.has(id)) continue;
		reached.add(id);
		for (const s of workflows.get(id)!.states)
			if (s.inherits_from?.kind === 'bundled_state')
				pending.push(states.get(s.inherits_from.state_id)!.workflow);
	}
	for (const [i, w] of document.workflows.entries())
		if (!reached.has(w.id))
			invalid(
				`/workflows/${i}`,
				'disconnected_workflow',
				'Every dependency workflow must be reachable through inheritance'
			);
	const inputs = new Map(document.inputs.map((input) => [input.id, input]));
	unique(
		document.inputs.map((input) => input.key),
		'/inputs',
		'duplicate_input_key'
	);
	for (const [i, input] of document.inputs.entries()) {
		add(input.id, `/inputs/${i}/id`);
		if (input.required_states)
			unique(
				input.required_states.map((s) => s.trim()),
				`/inputs/${i}/required_states`,
				'duplicate_required_state'
			);
	}
	const project = (id: string, path: string) =>
		requireRef(inputs.get(id)?.type === 'project', path, 'Expected a project input declaration');
	for (const [i, schedule] of document.schedules.entries()) {
		const p = `/schedules/${i}`;
		add(schedule.id, `${p}/id`);
		requireRef(workflows.has(schedule.workflow.workflow_id), `${p}/workflow`);
		project(schedule.project.input_id, `${p}/project`);
		if (schedule.start_state)
			requireRef(
				states.get(schedule.start_state.state_id)?.workflow === schedule.workflow.workflow_id,
				`${p}/start_state`,
				'Start state must belong to the scheduled workflow'
			);
		fields.set(schedule.id, {
			title_template: schedule.title_template,
			description_template: schedule.description_template
		});
	}
	const routingScopes = new Set<string>();
	for (const [i, routing] of document.routing.entries()) {
		const p = `/routing/${i}`;
		add(routing.id, `${p}/id`);
		requireRef(states.has(routing.scope.state_id), `${p}/scope/state_id`);
		if (routing.scope.project) project(routing.scope.project.input_id, `${p}/scope/project`);
		const key = JSON.stringify([routing.scope.state_id, routing.scope.project?.input_id ?? null]);
		if (routingScopes.has(key))
			invalid(p, 'duplicate_routing', 'Only one tier preference is allowed per scope');
		routingScopes.add(key);
	}
	const uses = new Map<
		string,
		{ source: string; declarations: { token: string; value: string }[]; paths: string[] }
	>();
	for (const [i, use] of document.text_uses.entries()) {
		const p = `/text_uses/${i}`;
		add(use.id, `${p}/id`);
		const input = inputs.get(use.input_id);
		requireRef(!!input, `${p}/input_id`);
		const target = fields.get(use.target.record_id);
		requireRef(
			!!target && Object.hasOwn(target, use.target.field),
			`${p}/target`,
			'Text use must target an allowed field on this record kind'
		);
		if (use.token !== inputToken(input!.key, input!.default))
			invalid(`${p}/token`, 'invalid_token', 'Token must match its declared input key and default');
		const key = JSON.stringify([use.target.record_id, use.target.field]);
		const group = uses.get(key) ?? {
			source: target![use.target.field],
			declarations: [],
			paths: []
		};
		group.declarations.push({ token: use.token, value: '' });
		group.paths.push(p);
		uses.set(key, group);
	}
	for (const group of uses.values()) {
		const result = renderDeclaredTokens(group.source, group.declarations);
		result.counts.forEach((count, i) => {
			if (!count)
				invalid(
					pointer(group.paths[i], 'token'),
					'unused_text_use',
					'Declaration must match at least one unescaped occurrence'
				);
		});
	}
}

export function validateWorkflowPackageReferences(document: WorkflowPackageDocument): void {
	validateLibraryV3References(document);
}
