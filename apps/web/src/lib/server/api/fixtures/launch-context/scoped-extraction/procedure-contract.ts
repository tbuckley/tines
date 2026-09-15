export type ExtractionCase = 'global' | 'project' | 'state' | 'combined';

export interface ProcedureAction {
	action: string;
	binding: string;
}

const CONTRACT: Record<ExtractionCase, Array<ProcedureAction & { pattern: RegExp }>> = {
	global: [
		{
			action: 'inspect_workflow',
			binding: 'target workflow',
			pattern: /inspect the target workflow/i
		},
		{
			action: 'enter_scouting',
			binding: 'planning required',
			pattern: /enter Scouting only when planning is required/i
		},
		{ action: 'attach_fresh', binding: 'proposal', pattern: /attach a fresh proposal/i },
		{
			action: 're_propose',
			binding: 'after fresh attachment',
			pattern: /before selecting Re-propose/i
		},
		{
			action: 'independent_approval',
			binding: 'authorized reviewer',
			pattern: /never approve your own proposal; stop for an authorized reviewer/i
		}
	],
	project: [
		{
			action: 'inspect_workflow',
			binding: 'project P Engineering',
			pattern: /inspect project P's Engineering workflow/i
		},
		{ action: 'enter_scouting', binding: 'project P', pattern: /move the issue to Scouting/i },
		{ action: 'draft', binding: 'accepted brief', pattern: /draft against the accepted brief/i },
		{ action: 'attach_fresh', binding: 'proposal', pattern: /attach a fresh proposal/i },
		{ action: 're_propose', binding: 'after fresh attachment', pattern: /before Re-propose/i },
		{
			action: 'independent_approval',
			binding: 'authorized reviewer',
			pattern: /leave approval to an authorized reviewer/i
		}
	],
	state: [
		{
			action: 'read_rejection',
			binding: 'current design',
			pattern: /read the rejection and the current design/i
		},
		{
			action: 'resolve_binding',
			binding: 'Root workflow',
			pattern: /using Root's workflow binding/i
		},
		{ action: 'attach_fresh', binding: 'design', pattern: /attach a fresh design/i },
		{ action: 're_propose', binding: 'after fresh attachment', pattern: /before Re-propose/i },
		{ action: 'independent_approval', binding: 'no self approval', pattern: /never self-approve/i }
	],
	combined: [
		{
			action: 'read_rejection',
			binding: 'current source and destination versions',
			pattern: /re-read the rejection and current source\/destination versions/i
		},
		{
			action: 'resolve_binding',
			binding: 'Root inherited by child',
			pattern: /preserve Root's binding while working in an inheriting child/i
		},
		{ action: 'attach_fresh', binding: 'proposal', pattern: /attach a fresh proposal/i },
		{ action: 're_propose', binding: 'after fresh attachment', pattern: /before Re-propose/i },
		{ action: 'independent_approval', binding: 'no self approval', pattern: /never self-approve/i }
	]
};

const CONTRADICTIONS = [
	/^\s*\d+\.\s+Never enter Scouting/im,
	/^\s*\d+\.\s+(?:Select|Use) Re-propose before attach/im,
	/^\s*\d+\.\s+(?:Approve your own proposal|Self-approve)[.;]?\s*$/im
];

/** Execute the fixture consumer's planning read into an ordered, scope-bound plan. */
export function planningProcedure(caseId: ExtractionCase, body: string): ProcedureAction[] {
	for (const contradiction of CONTRADICTIONS) {
		const match = body.match(contradiction)?.[0];
		if (match) throw new Error(`contradictory planning instruction: ${match.trim()}`);
	}

	let previous = -1;
	return CONTRACT[caseId].map(({ pattern, action, binding }) => {
		const match = pattern.exec(body);
		if (!match) throw new Error(`missing ${caseId} planning action: ${action}`);
		if (match.index <= previous)
			throw new Error(`out-of-order ${caseId} planning action: ${action}`);
		previous = match.index;
		return { action, binding };
	});
}

export function expectedPlanningProcedure(caseId: ExtractionCase): ProcedureAction[] {
	return CONTRACT[caseId].map(({ action, binding }) => ({ action, binding }));
}
