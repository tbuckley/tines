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
	replaced: 'overridden at destination'
};

/** The item lines an operator inspects by index with `--inspect <n>`. */
export function inspectableChanges(preview: IssueTransferPreview): IssueTransferContextChange[] {
	return preview.context.changes.filter((c) => c.change !== 'retained');
}

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
				`           pinned runner ${explainer.pin.runner_name ?? explainer.pin.runner_id}${
					explainer.pin.tier ? ` (${explainer.pin.tier})` : ''
				} — retained by the move`
			);
		}
		for (const tie of explainer.ambiguous_rules) {
			lines.push(`           tied rule ${tie.scope_label}`);
		}
	}
	lines.push('  Capacity, heartbeats and spending are advisory and may change at any moment.');
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
	lines.push('', changes.length ? 'Guidance changes:' : 'Guidance: unchanged by this move.');
	changes.forEach((change, index) => {
		lines.push(`  [${index}] ${change.kind} "${change.name}" — ${CHANGE_LABEL[change.change]}`);
		const scopeBefore = change.scope_before?.label ?? '—';
		const scopeAfter = change.scope_after?.label ?? '—';
		lines.push(`      scope: ${scopeBefore} => ${scopeAfter}`);
		const repo = repoLine(change);
		if (repo) lines.push(repo);
	});
	for (const conflict of preview.context.after.conflicts) {
		lines.push(
			`  ! ${conflict.item_ids.length} repositories still want the "${conflict.dir}" directory at the destination`
		);
	}

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
	const side = change.change === 'removed' ? preview.context.before : preview.context.after;
	const prompt = side.prompt.parts.find((part) => part.item_id === change.item_id);
	if (prompt) return `${change.name} (prompt, ${prompt.scope.label})\n${prompt.body}`;
	const skill = side.skills.find((s) => s.item_id === change.item_id);
	if (skill) {
		return [
			`${change.name} (skill, ${skill.scope.label})`,
			...skill.files.map((f) => `--- ${f.path}\n${f.content}`)
		].join('\n');
	}
	const repo = side.repos.find((r) => r.item_id === change.item_id);
	if (repo)
		return `${change.name} (repo, ${repo.scope.label})\n${repo.url} ${repo.branch ?? ''} → ${repo.dir}`;
	return `${change.name} (${change.kind}) is not effective on either side; nothing to show.`;
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
