/** Rendering for `tines issues transfer` — the review an operator confirms. */
import type {
	IssueTransferContextChange,
	IssueTransferPreview,
	IssueTransferResult
} from '@tines/shared';

const CHANGE_LABEL: Record<IssueTransferContextChange['change'], string> = {
	added: 'added by destination',
	removed: 'removed with source',
	retained: 'retained',
	rescoped: 'moves with the issue',
	replaced: 'effective selection changes'
};

/** The item lines an operator inspects by index with `--inspect <n>`. */
export function inspectableChanges(preview: IssueTransferPreview): IssueTransferContextChange[] {
	return preview.context.changes;
}

const effectiveness = (present: boolean, effective: boolean) =>
	!present ? 'not present' : effective ? 'effective' : 'overridden candidate';

function repoLine(change: IssueTransferContextChange): string | null {
	if (change.kind !== 'repo') return null;
	const before = change.repo_before;
	const after = change.repo_after;
	const show = (r: typeof before) =>
		r ? `${r.url}${r.branch ? `#${r.branch}` : ''} → ${r.dir}` : 'none';
	if (!before && !after) return null;
	return `      checkout: ${show(before)} => ${show(after)}`;
}

function routingLines(preview: IssueTransferPreview): string[] {
	const lines: string[] = ['', 'Routing:'];
	for (const [label, explainer] of [
		['  before', preview.routing.before],
		['  after ', preview.routing.after]
	] as const) {
		if (!explainer) {
			lines.push(`${label}: no explanation available`);
			continue;
		}
		lines.push(`${label}: ${explainer.verdict}`);
		if (explainer.pin) {
			lines.push(
				`           pin: runner ${explainer.pin.runner_name ?? explainer.pin.runner_id}, tier ${explainer.pin.tier ?? 'default'}`
			);
		}
		for (const check of explainer.checks) {
			lines.push(
				`           ${check.ok ? 'pass' : 'FAIL'} ${check.name}: ${check.detail}${check.action?.label ? ` (${check.action.label})` : ''}`
			);
		}
		if (explainer.matched_rule)
			lines.push(`           matched rule ${explainer.matched_rule.scope_label}`);
		for (const tie of explainer.ambiguous_rules) {
			lines.push(`           tied rule ${tie.scope_label}`);
		}
		if (explainer.runner_rule)
			lines.push(`           runner source rule ${explainer.runner_rule.scope_label}`);
		if (explainer.tier_override) lines.push(`           tier override ${explainer.tier_override}`);
		for (const target of explainer.targets) {
			lines.push(
				`           target ${target.runner_name} — ${target.tier}${target.model ? ` / ${target.model}` : ''}: ${target.verdict} — ${target.detail}`
			);
		}
		if (explainer.active_run)
			lines.push(
				`           active run ${explainer.active_run.id} (${explainer.active_run.status})`
			);
		if (explainer.queue_position !== null)
			lines.push(`           queue position ${explainer.queue_position}`);
		lines.push(
			`           attempts ${explainer.attempt_count}/${explainer.attempt_limit}; parked ${explainer.parked ? 'yes' : 'no'}`
		);
	}
	lines.push('  Capacity, heartbeats and spending are advisory and may change at any moment.');
	return lines;
}

function repoDetail(repo: { url: string; branch?: string | null; dir: string }): string {
	return `${repo.url}; branch ${repo.branch ?? 'repository default branch'}; directory ${repo.dir}`;
}

function effectiveRepositoryLines(preview: IssueTransferPreview): string[] {
	const lines = ['', 'Effective repositories:'];
	for (const [label, context] of [
		['  before', preview.context.before],
		['  after ', preview.context.after]
	] as const) {
		lines.push(`${label}:`);
		if (!context.repos.length) lines.push('    none');
		for (const repo of context.repos) {
			lines.push(`    ${repo.name} — effective (${repo.scope.label})`);
			lines.push(`      ${repoDetail(repo)}`);
			for (const loser of context.overridden.filter(
				(item) => item.kind === 'repo' && item.name === repo.name
			)) {
				lines.push(
					`      overridden candidate ${loser.name} (${loser.scope.label}) — overridden by ${loser.overridden_by}`
				);
				lines.push(
					`        ${loser.repo ? repoDetail(loser.repo) : 'checkout details unavailable from this server'}`
				);
			}
		}
	}
	return lines;
}

function conflictLines(preview: IssueTransferPreview): string[] {
	const lines = ['', 'Repository checkout conflicts:'];
	for (const [label, context] of [
		['  before', preview.context.before],
		['  after ', preview.context.after]
	] as const) {
		if (!context.conflicts.length) lines.push(`${label}: none`);
		for (const conflict of context.conflicts) {
			const participants = conflict.item_ids
				.map((id) => {
					const repo = context.repos.find((item) => item.item_id === id);
					return repo ? `${repo.name} (${repo.scope.label})` : id;
				})
				.join(', ');
			lines.push(`${label}: ${conflict.dir} — ${participants}`);
		}
	}
	return lines;
}

/**
 * The human review. Deliberately complete rather than compact: this is the only
 * thing standing between an operator and an irreversible-by-hand move.
 */
export function formatTransferPreview(preview: IssueTransferPreview): string {
	const p = preview.preserved;
	const lines: string[] = [
		`Move ${preview.old_ref.ref} from ${preview.source.name} to ${preview.destination.name}`,
		`  ${preview.number_notice} The issue keeps its stable ID (${preview.issue_id}) and every old ref keeps working.`,
		'',
		'Preserved:',
		`  "${p.title}" — state unchanged, entered ${new Date(p.state_entered_at).toISOString()}`,
		`  ${p.comment_count} comment(s), ${p.artifact_count} artifact(s) in ${p.artifact_version_count} version(s), ${p.run_count} run(s), ${p.link_count} link(s)`,
		`  labels: ${p.labels.map((l) => l.name).join(', ') || 'none'}`,
		`  pins: ${p.pinned_runner_id ?? 'none'}${p.pinned_tier ? ` (${p.pinned_tier})` : ''}; attempts ${p.attempt_count}${p.parked ? '; parked' : ''}`
	];

	const changes = inspectableChanges(preview);
	lines.push('', changes.length ? 'Guidance:' : 'Guidance: none.');
	changes.forEach((change, index) => {
		lines.push(`  [${index}] ${change.kind} "${change.name}" — ${CHANGE_LABEL[change.change]}`);
		const scopeBefore = change.scope_before?.label ?? '—';
		const scopeAfter = change.scope_after?.label ?? '—';
		lines.push(`      scope: ${scopeBefore} => ${scopeAfter}`);
		lines.push(
			`      before: ${effectiveness(Boolean(change.scope_before), change.effective_before)}; after: ${effectiveness(Boolean(change.scope_after), change.effective_after)}`
		);
		const repo = repoLine(change);
		if (repo) lines.push(repo);
	});
	lines.push(...effectiveRepositoryLines(preview), ...conflictLines(preview));

	lines.push(...routingLines(preview));

	if (preview.schedule) {
		lines.push(
			'',
			`Schedule: ${preview.schedule.name} (${preview.schedule.project_name}) — ${preview.schedule.notice}`
		);
	}
	if (preview.blockers.length) {
		lines.push('', 'Cannot move yet:');
		for (const blocker of preview.blockers) {
			lines.push(
				`  ${blocker.code}: ${blocker.message}${blocker.remedy ? ` (${blocker.remedy})` : ''}`
			);
		}
	}
	if (preview.noop)
		lines.push('', 'This issue is already in that project; moving would change nothing.');
	return lines.join('\n');
}

/** The full body/files behind one reviewed item, from the preview itself. */
export function formatTransferItem(preview: IssueTransferPreview, index: number): string {
	const change = inspectableChanges(preview)[index];
	if (!change) return `no item [${index}] in this review`;
	const beforePrompt = preview.context.before.prompt.parts.find(
		(part) => part.item_id === change.item_id
	);
	const afterPrompt = preview.context.after.prompt.parts.find(
		(part) => part.item_id === change.item_id
	);
	if (beforePrompt || afterPrompt) {
		if (beforePrompt?.body === afterPrompt?.body)
			return `${change.name} (prompt, Before and after)\n${beforePrompt?.body ?? afterPrompt?.body}`;
		return [
			beforePrompt
				? `${change.name} (prompt, Before — ${beforePrompt.scope.label})\n${beforePrompt.body}`
				: '',
			afterPrompt
				? `${change.name} (prompt, After — ${afterPrompt.scope.label})\n${afterPrompt.body}`
				: ''
		]
			.filter(Boolean)
			.join('\n\n');
	}
	const skill =
		preview.context.after.skills.find((s) => s.item_id === change.item_id) ??
		preview.context.before.skills.find((s) => s.item_id === change.item_id);
	if (skill) {
		return [
			`${change.name} (skill, ${skill.scope.label})`,
			...skill.files.map((f) => `--- ${f.path}\n${f.content}`)
		].join('\n');
	}
	const repo =
		preview.context.after.repos.find((r) => r.item_id === change.item_id) ??
		preview.context.before.repos.find((r) => r.item_id === change.item_id);
	if (repo) return `${change.name} (repo, ${repo.scope.label})\n${repoDetail(repo)}`;
	const candidate = [
		...preview.context.after.overridden,
		...preview.context.before.overridden
	].find((item) => item.item_id === change.item_id);
	if (candidate?.repo)
		return `${change.name} (overridden repo candidate, ${candidate.scope.label})\n${repoDetail(candidate.repo)}`;
	return `${change.name} (${change.kind}) is an overridden candidate; content details are unavailable from this server.`;
}

export function formatTransferResult(result: IssueTransferResult): string {
	if (result.status === 'noop') {
		return `${result.old_ref.ref} is already in ${result.destination.name}; nothing changed`;
	}
	return [
		`moved ${result.old_ref.ref} to ${result.new_ref.ref}`,
		`  ${result.old_ref.ref} still resolves to this issue`,
		`  ${result.new_ref.ref}`
	].join('\n');
}

/**
 * The terminal an interactive confirmation talks to. Injected so the answers an
 * operator can give — including no answer at all — are testable without a pty.
 */
export type TransferTerminal = {
	/** Where the review and the prompts go: never stdout, which `--json` owns. */
	write: (text: string) => void;
	/** One answer, or `null` when the input ended without one (EOF). */
	ask: (question: string) => Promise<string | null>;
};

export type TransferDecision = { action: 'commit' } | { action: 'abort'; reason: string };

/**
 * Review, inspect, answer. Inspecting an item is not an answer: the question is
 * asked again afterwards, so nothing commits on the strength of a keystroke the
 * operator spent looking at content.
 */
export async function confirmTransfer(
	preview: IssueTransferPreview,
	terminal: TransferTerminal,
	notice?: string
): Promise<TransferDecision> {
	if (notice) terminal.write(`${notice}\n`);
	terminal.write(`${formatTransferPreview(preview)}\n`);
	const inspectable = inspectableChanges(preview).length;
	for (;;) {
		const hint = inspectable ? `, or a number 0-${inspectable - 1} to read that item` : '';
		const answer = await terminal.ask(
			`Move ${preview.old_ref.ref} to ${preview.destination.name}? [y/N${hint}] `
		);
		if (answer === null) return { action: 'abort', reason: 'no answer' };
		const trimmed = answer.trim();
		if (/^\d+$/.test(trimmed)) {
			terminal.write(`${formatTransferItem(preview, Number(trimmed))}\n`);
			continue;
		}
		if (/^y(es)?$/i.test(trimmed)) return { action: 'commit' };
		return { action: 'abort', reason: 'aborted' };
	}
}
