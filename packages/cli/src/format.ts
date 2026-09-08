/**
 * Presentation helpers: pure value -> string, no I/O. Kept separate from the
 * commands so the strings agents read can be pinned by tests.
 *
 * `eventSummary` is deliberately absent: it lives in @tines/shared (Tines/49),
 * since the web renders the same events from the same describer.
 */
import type {
	AgentRun,
	ArrivedVia,
	Artifact,
	ArtifactRequirementCheck,
	ArtifactVersion,
	Comment,
	ContextItem,
	LinkedIssue,
	QuotaPolicy,
	Round,
	RoundArtifactChange,
	RoundRun,
	RoundSummary,
	RoutingRule,
	Runner,
	Schedule,
	SinceLastRun
} from '@tines/shared';
import {
	actorLabel,
	ageLabel as sharedAgeLabel,
	describeRecurrence,
	prUrlOf,
	runCostLabel,
	runDurationLabel
} from '@tines/shared';
import type { KeptWorkspace } from './daemon/store.js';

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
export function linkRows(
	entries: LinkedIssue[],
	note: (e: LinkedIssue) => string = () => ''
): string[][] {
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
			return `${prRefLabel(cv)} — ${prUrlOf(cv)}`;
	}
}

/**
 * The type and declared MIME of an artifact, short enough for the line that
 * confirms an attach: `text, text/markdown`, `file, image/png`, `folder`.
 * The fuller `artifactSummary` (filename, sizes, URLs) stays for show/list.
 */
export function artifactTypeLabel(a: Pick<Artifact, 'artifact_type' | 'current_version'>): string {
	const ct = a.current_version.content_type;
	return (a.artifact_type === 'file' || a.artifact_type === 'text') && ct
		? `${a.artifact_type}, ${ct}`
		: a.artifact_type;
}

/** A requirement's live status, written the way a reader decides what to do next. */
function requirementStatus(r: ArtifactRequirementCheck): string {
	switch (r.status) {
		case 'satisfied':
			return `satisfied (v${r.current_version?.version})`;
		case 'missing':
			return 'missing';
		case 'stale':
			return `stale (v${r.current_version?.version}, attached before the current state)`;
		case 'type_mismatch':
			// Two different misses wear the same status: the wrong (immutable)
			// type, which needs a delete, and a content type outside the gate's
			// prefix, which a new version fixes. Say which.
			return r.type !== undefined && r.current_type !== null && r.current_type !== r.type
				? `type mismatch (holds ${r.current_type})`
				: `type mismatch (v${r.current_version?.version} is not ${r.content_type ?? r.type})`;
	}
}

/**
 * The two lines every requirement is rendered as — what it wants plus the
 * runnable fix. `issues show` and the `transition_requirements_unmet` 422 both
 * print these, so the pre-flight view and the failure cannot drift.
 */
export function requirementLines(r: ArtifactRequirementCheck): string[] {
	const spec = [r.type, r.content_type].filter(Boolean).join(', ');
	return [
		`requires artifact "${r.artifact}"${spec ? ` (${spec})` : ''}: ${requirementStatus(r)}${r.description ? ` — ${r.description}` : ''}`,
		...(r.fix ? [`  fix: ${r.fix}`] : [])
	];
}

export function scheduleRef(s: Schedule): string {
	return `${s.project_name}/${s.name}`;
}

export function runnerStatusLabel(runner: Runner): string {
	if (runner.status === 'paused') return 'paused';
	// Before the online check: a rate-limited daemon is polling happily, and
	// "online" is exactly the wrong thing to say about a runner taking no work.
	if (runner.backoff_reason === 'rate_limit' && (runner.backoff_until ?? 0) > Date.now())
		return 'rate limited';
	return runner.online ? 'online' : 'offline';
}

export function ruleTargetsLabel(rule: RoutingRule): string {
	if (rule.targets.length === 0) return '(no targets)';
	if (rule.targets.length === 1 && rule.targets[0]?.runner_id === '*') {
		return `*:${rule.targets[0].tier} (inherited runners)`;
	}
	return rule.targets
		.map(
			(t) =>
				`${t.runner_name}${t.tier ? `:${t.tier}` : ''}${t.runner_status === 'paused' ? ' (paused)' : ''}`
		)
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

/**
 * One comment as `issues show` prints it: a blank separator, the header line,
 * then the body indented under it. The id is in the header because
 * `issues comment-edit`/`comment-delete` take it, and `issues show` is where
 * an agent with no browser finds it.
 */
export function commentLines(comment: Comment): string[] {
	const header = `  [${timestamp(comment.created_at)}] ${actorLabel(comment.actor)} (${comment.id})${comment.updated_at ? ' (edited)' : ''}:`;
	return ['', header, ...comment.body.split('\n').map((line) => `  ${line}`)];
}

/**
 * "since the last run" for `issues show` on an active issue: the human's steer
 * that started this round, comments and all.
 */
export function sinceLastRunLines(since: SinceLastRun, now: number = Date.now()): string[] {
	const prev = since.previous_run;
	const ended =
		prev.ended_at === null ? 'not ended' : `ended ${sharedAgeLabel(prev.ended_at, now)} ago`;
	const lines = [
		`since the last run (${prev.state_at_start_name ?? 'unknown state'}, ${prev.run_id} ${ended}):`
	];
	const t = since.transition;
	if (t) {
		const via = t.action ? `via "${t.action}"` : 'moved directly';
		const stale =
			since.stale_artifacts.length > 0 ? ` — now stale: ${since.stale_artifacts.join(', ')}` : '';
		lines.push(
			`  moved from ${t.from_state.name} ${via} by ${actorLabel(t.actor)} ${sharedAgeLabel(t.at, now)} ago${stale}`
		);
	}
	for (const c of since.comments) lines.push(...commentLines(c));
	if (since.comment_count > since.comments.length) {
		const hidden = since.comment_count - since.comments.length;
		lines.push(`  … and ${hidden} earlier comment${hidden === 1 ? '' : 's'}`);
	}
	return lines;
}

/** "round" for `issues show` on an awaiting-human issue: what came back. */
export function roundLines(round: Round, now: number = Date.now()): string[] {
	const b = round.boundary;
	const from = b
		? `since ${actorLabel(b.actor)} ${b.action ? `moved "${b.action}"` : 'moved it directly'} ${timestamp(b.at)}`
		: `since created ${timestamp(round.boundary_at)}`;
	const lines = [`round (${round.run_count} run${round.run_count === 1 ? '' : 's'} ${from}):`];
	for (const stage of round.stages) {
		const [latest, ...earlier] = stage.runs;
		if (!latest) continue;
		lines.push(`  ${stage.state.name ?? stage.state.id} — ${runHeadline(latest, now)}`);
		if (latest.artifacts.length > 0) {
			lines.push(`    ${latest.artifacts.map(artifactChangeLabel).join(' · ')}`);
		}
		// Earlier attempts fold to one line each, above the latest run's summary
		// so a long summary body cannot read as swallowing them. The lines say
		// how many there were, so no counter follows.
		for (const run of earlier) lines.push(`    ${earlierAttemptLine(run, now)}`);
		if (latest.summary_comment) {
			lines.push(`    summary (${latest.summary_comment.id}):`);
			for (const line of latest.summary_comment.body.split('\n')) lines.push(`      ${line}`);
		}
		const earlierComments = latest.earlier_comment_ids;
		if (earlierComments.length > 0) {
			lines.push(
				`    ${earlierComments.length} earlier comment${earlierComments.length === 1 ? '' : 's'}: ${earlierComments.join(', ')}`
			);
		}
	}
	return lines;
}

function runHeadline(run: RoundRun, now: number): string {
	const cost = runCostLabel(run);
	return [
		`${run.run_id} on ${run.runner_name}`,
		runDurationLabel(run, now),
		run.outcome ?? run.status,
		...(cost ? [cost] : []),
		run.transition
			? `"${run.transition.action ?? 'moved directly'}" → ${run.transition.to_state.name}`
			: 'no transition'
	].join(' · ');
}

function earlierAttemptLine(run: RoundRun, now: number): string {
	const back = run.returned_via;
	const how = back
		? back.action
			? `sent back by ${back.from_state.name} ("${back.action}")`
			: 'moved directly back'
		: 'never came back';
	return `${run.run_id} · ${runDurationLabel(run, now)} · ${run.outcome ?? run.status} · ${how}`;
}

function artifactChangeLabel(a: RoundArtifactChange): string {
	const versions =
		a.from_version === null ? `v${a.to_version}` : `v${a.from_version} → v${a.to_version}`;
	const extra = a.pr_url
		? ` (${a.pr_url})`
		: a.files
			? ` (${a.files.length} file${a.files.length === 1 ? '' : 's'})`
			: '';
	return `${a.name} ${versions}${extra}`;
}

/** The VIA column: how an awaiting issue arrived where it is. */
export function arrivedViaLabel(via: ArrivedVia | null): string {
	if (!via) return '—';
	return via.action ?? 'moved directly';
}

/** The ROUND column: the pull request and artifacts the round produced. */
export function roundSummaryLabel(summary: RoundSummary | null): string {
	if (!summary) return '—';
	const parts = [
		...(summary.pr_url ? [`PR ${summary.pr_url.split('/').pop()}`] : []),
		...summary.artifacts.map((a) => `${a.name} v${a.version}`)
	];
	return parts.length > 0 ? parts.join(' · ') : '—';
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

/** Compact byte count for a table cell: "0 B", "912 KB", "4.6 MB", "1.3 GB". */
export function byteSize(bytes: number): string {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = Math.max(0, bytes);
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	// Whole bytes and kilobytes read better without a decimal; larger units
	// need one to tell 4.6 MB from 4.0 MB.
	const rounded = unit <= 1 ? Math.round(value) : Math.round(value * 10) / 10;
	return `${unit <= 1 ? rounded : rounded.toFixed(1)} ${units[unit]}`;
}

/** Compact age of an ISO timestamp, in the style of run durations: "42s", "3h", "5d". */
export function ageLabel(isoTimestamp: string, now: number = Date.now()): string {
	return sharedAgeLabel(Date.parse(isoTimestamp), now);
}

/**
 * How long something has been waiting, epoch-millis in: "0.3h", "21h", "8d".
 * The Now row's own unit (Tines/256) — `ageLabel` takes an ISO string and
 * rounds hours down, which reads as "0h" for everything under the hour.
 */
export function hoursLabel(ms: number, now: number = Date.now()): string {
	const hours = Math.max(0, now - ms) / 3_600_000;
	if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`;
	return `${Math.round(hours / 24)}d`;
}

/**
 * One kept workspace as `runner workspaces` prints it. The size is passed in
 * rather than measured here: this file stays free of I/O.
 */
export function keptWorkspaceRow(
	kept: KeptWorkspace,
	sizeBytes: number,
	now: number = Date.now()
): string[] {
	return [
		kept.run_id,
		kept.issue_ref ?? '—',
		kept.status,
		ageLabel(kept.kept_at, now),
		byteSize(sizeBytes),
		kept.path
	];
}

/** Column-aligned rows, one line each, trailing padding trimmed. */
export function formatTable(rows: string[][]): string {
	if (rows.length === 0) return '';
	const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
	return rows
		.map((row) =>
			row
				.map((cell, i) => cell.padEnd(widths[i]))
				.join('  ')
				.trimEnd()
		)
		.join('\n');
}
