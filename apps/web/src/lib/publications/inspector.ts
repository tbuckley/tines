import type { PackageContext, WorkflowPackageDocument } from '@tines/shared';

export type InspectorTarget =
	| { kind: 'workflow'; workflowId: string }
	| { kind: 'state'; stateId: string }
	| { kind: 'input'; inputId: string }
	| { kind: 'field'; recordId: string; field: string };

export function inspectorTargetId(target: InspectorTarget): string {
	const parts =
		target.kind === 'workflow'
			? [target.workflowId]
			: target.kind === 'state'
				? [target.stateId]
				: target.kind === 'input'
					? [target.inputId]
					: [target.recordId, target.field];
	return `public-${target.kind}-${parts.map((part) => `${part.length}-${part}`).join('-')}`;
}

export interface InstructionLayer {
	stateId: string;
	stateName: string;
	workflowName: string;
	local: boolean;
	items: Array<{ item: PackageContext; overriddenBy: string | null }>;
}

/** Effective instruction order is root-to-leaf, then local, without reordering document records. */
export function publicInstructionLayers(
	document: WorkflowPackageDocument,
	localStateId: string
): InstructionLayer[] {
	const stateIndex = new Map(
		document.workflows.flatMap((workflow) =>
			workflow.states.map((state) => [state.id, { state, workflow }] as const)
		)
	);
	const chain: string[] = [];
	const visited = new Set<string>();
	let current: string | undefined = localStateId;
	while (current && !visited.has(current)) {
		visited.add(current);
		const entry = stateIndex.get(current);
		if (!entry) break;
		chain.unshift(current);
		current =
			entry.state.inherits_from?.kind === 'bundled_state'
				? entry.state.inherits_from.state_id
				: undefined;
	}
	const winner = new Map<string, string>();
	for (const stateId of chain) {
		for (const item of document.context) {
			if (item.state_id === stateId && item.kind !== 'prompt')
				winner.set(`${item.kind}\0${item.name}`, item.id);
		}
	}
	return chain.flatMap((stateId) => {
		const entry = stateIndex.get(stateId);
		if (!entry) return [];
		return [
			{
				stateId,
				stateName: entry.state.name,
				workflowName: entry.workflow.name,
				local: stateId === localStateId,
				items: document.context
					.filter((item) => item.state_id === stateId)
					.map((item) => ({
						item,
						overriddenBy:
							item.kind === 'prompt'
								? null
								: winner.get(`${item.kind}\0${item.name}`) === item.id
									? null
									: (winner.get(`${item.kind}\0${item.name}`) ?? null)
					}))
			}
		];
	});
}
