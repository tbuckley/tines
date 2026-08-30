/**
 * Presentation helpers: pure value -> string, no I/O. Kept separate from the
 * commands so the strings agents read can be pinned by tests.
 *
 * `eventSummary` is deliberately absent — it moves to @tines/shared under
 * Tines/49, since the web renders the same events.
 */
import type {
	AgentRun,
	Artifact,
	ArtifactVersion,
	ContextItem,
	IssueDetail,
	LinkedIssue,
	QuotaPolicy,
	RoutingRule,
	Runner,
	Schedule
} from '@tines/shared';
import { describeRecurrence, runCostLabel, runDurationLabel } from '@tines/shared';

export function timestamp(ms: number): string {
	return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

export function contextItemSummary(item: ContextItem): string {
	switch (item.kind) {
		case 'prompt':
			return `${Buffer.byteLength(item.body ?? '', 'utf8')} bytes`;
		case 'skill':
			return `${item.file_count ?? item.files?.length ?? 0} file${(item.file_count ?? item.files?.length ?? 0) === 1 ? '' : 's'}`;
		case 'repo':
			return `${item.repo_url}${item.repo_branch ? `#${item.repo_branch}` : ''}`;
		case 'artifact':
			return item.artifact_type ?? 'artifact';
	}
}

export function recurrenceLabel(schedule: Schedule): string {
	return `${describeRecurrence(schedule.preset, schedule.cron)}, ${schedule.timezone}`;
}

export function issueRef(ref: { project_name: string; number: number }): string {
	return `${ref.project_name}/${ref.number}`;
}

/** One table row per linked issue: ref, title, effective state, optional note. */
export function linkRows(entries: LinkedIssue[], note: (e: LinkedIssue) => string = () => ''): string[][] {
	return entries.map((e) => [
		`  ${issueRef(e)}`,
		e.title,
		`${e.effective_state.name} (${e.effective_state.category})`,
		note(e)
	]);
}

const MIME_BY_EXT: Record<string, string> = {
	md: 'text/markdown',
	markdown: 'text/markdown',
	txt: 'text/plain',
	log: 'text/plain',
	html: 'text/html',
	htm: 'text/html',
	css: 'text/css',
	csv: 'text/csv',
	js: 'text/javascript',
	json: 'application/json',
	pdf: 'application/pdf',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	zip: 'application/zip',
	gz: 'application/gzip',
	mp4: 'video/mp4',
	webm: 'video/webm'
};

export function sniffContentType(path: string): string {
	const ext = path.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
	return (ext && MIME_BY_EXT[ext]) || 'application/octet-stream';
}

/** `owner/repo#N` for a pr version (falls back to the raw URL parts). */
export function prRefLabel(v: Pick<ArtifactVersion, 'pr_repo_url' | 'pr_number'>): string {
	const path = (v.pr_repo_url ?? '').replace(/^https:\/\/github\.com\//, '');
	return `${path}#${v.pr_number}`;
}

export function artifactSummary(a: Artifact): string {
	const cv = a.current_version;
	switch (a.artifact_type) {
		case 'file':
			return `${cv.filename} (${cv.content_type}, ${cv.size_bytes} bytes)`;
		case 'folder':
			return `${cv.file_count} file${cv.file_count === 1 ? '' : 's'} (${cv.size_bytes} bytes total)`;
		case 'text':
			return `${cv.filename} (${cv.content_type})`;
		case 'link':
			return cv.title ? `${cv.title} — ${cv.url}` : (cv.url ?? '');
		case 'pr':
			return `${prRefLabel(cv)} — ${cv.pr_repo_url}/pull/${cv.pr_number}`;
	}
}

export function scheduleRef(s: Schedule): string {
	return `${s.project_name}/${s.name}`;
}

export function runnerStatusLabel(runner: Runner): string {
	if (runner.status === 'paused') return 'paused';
	return runner.online ? 'online' : 'offline';
}

export function ruleTargetsLabel(rule: RoutingRule): string {
	if (rule.targets.length === 0) return '(no targets)';
	return rule.targets
		.map((t) => `${t.runner_name}${t.tier ? `:${t.tier}` : ''}${t.runner_status === 'paused' ? ' (paused)' : ''}`)
		.join(' → ');
}

/** Human-readable policy line; state names resolved when workflows are given. */
export function quotaLabel(quota: QuotaPolicy, stateName?: (id: string) => string): string {
	if (quota.type === 'global_cap') return `global cap: at most ${quota.limit} concurrent runs`;
	const overrides = Object.entries(quota.overrides).map(
		([id, limit]) => `${stateName ? stateName(id) : id}=${limit}`
	);
	return `state roster: default ${quota.default_limit} per state${overrides.length > 0 ? `, overrides: ${overrides.join(', ')}` : ''}`;
}

export function runRow(run: AgentRun): string[] {
	return [
		run.id,
		run.issue_ref ? issueRef(run.issue_ref) : run.issue_id,
		run.runner_name,
		`${run.tier}${run.model ? ` (${run.model})` : ''}`,
		run.status,
		runDurationLabel(run),
		runCostLabel(run) ?? '—',
		timestamp(run.created_at)
	];
}

/** Column-aligned rows, one line each, trailing padding trimmed. */
export function formatTable(rows: string[][]): string {
	if (rows.length === 0) return '';
	const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
	return rows
		.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd())
		.join('\n');
}
