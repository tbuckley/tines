/** `tines issues` — issues, their artifacts, and their links. */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
	client,
	die,
	printJson,
	printList,
	resolveIssue,
	resolveProject,
	resolveRunner,
	resolveWorkflow,
	table,
	withCommon,
	withList,
	type CommonOpts,
	type ListOpts
} from '../common.js';
import {
	artifactSummary,
	issueRef,
	linkRows,
	prRefLabel,
	recurrenceLabel,
	sniffContentType,
	timestamp
} from '../format.js';
import { helpGuard } from '../help-guard.js';
import { buildRecurrence, type RecurrenceOpts } from '../recurrence-flags.js';
import { parseTargetSpec, readBodyValue } from '../refs.js';
import {
	actorLabel,
	parsePrSpec,
	type Artifact,
	type CreateScheduleInput,
	type DispatchExplainer,
	type IssueDetail,
	type IssueLinks,
	type StateCategory,
	type UpdateIssueRequest
} from '@tines/shared';
import type { Command } from 'commander';

const systemTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The link sections of `issues show`; empty groups are omitted entirely. */
function printIssueLinks(links: IssueLinks): void {
	if (links.blocked_by.length > 0) {
		console.log('\nblocked by:');
		// Open blockers are exactly why the issue isn't ready, so call them out.
		table(linkRows(links.blocked_by, (e) => (e.effective_state.category === 'done' ? '' : '(open)')));
	}
	if (links.blocks.length > 0) {
		console.log('\nblocks:');
		table(linkRows(links.blocks));
	}
	if (links.duplicate_of) {
		console.log('\nduplicate of:');
		table(linkRows([links.duplicate_of], () => '(the state shown above follows it)'));
	}
	if (links.duplicated_by.length > 0) {
		console.log('\nduplicates:');
		table(linkRows(links.duplicated_by));
	}
}

function printIssueDetail(issue: IssueDetail): void {
	console.log(`${issue.project_name}/#${issue.number}  ${issue.title}`);
	// The state line carries the effective state; on a duplicate that is the
	// canonical issue's, and the issue's own (dormant) state moves below it.
	const dup = issue.duplicate_of;
	console.log(
		`state: ${issue.effective_state.name} (${issue.effective_state.category})${dup ? ` (via ${issueRef(dup)} — duplicate)` : ''}  workflow: ${issue.workflow.name}  updated: ${timestamp(issue.updated_at)}`
	);
	if (dup) {
		console.log(`own state: ${issue.state.name} (${issue.state.category}) — dormant while this is a duplicate`);
	}
	console.log(`id: ${issue.id}`);
	printIssueLinks(issue.links);
	if (issue.description) {
		console.log(`\n${issue.description}`);
	}
	const allowed = issue.allowed_transitions.map((t) => `"${t.name}" → ${t.to_state.name}`);
	console.log(`\nallowed actions: ${allowed.length ? allowed.join(', ') : 'none (terminal state)'}`);
	if (issue.comments.length > 0) {
		console.log(`\ncomments (${issue.comments.length}):`);
		for (const c of issue.comments) {
			console.log(`\n  [${timestamp(c.created_at)}] ${actorLabel(c.actor)}:`);
			for (const line of c.body.split('\n')) console.log(`  ${line}`);
		}
	}
}

/** All regular files under a directory, workspace-relative with `/` separators. */
function walkFolder(dir: string): { path: string; contentType: string; bytes: Buffer }[] {
	const files: { path: string; contentType: string; bytes: Buffer }[] = [];
	const walk = (abs: string, rel: string) => {
		for (const entry of readdirSync(abs, { withFileTypes: true })) {
			const nextAbs = join(abs, entry.name);
			const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(nextAbs, nextRel);
			else if (entry.isFile()) {
				files.push({ path: nextRel, contentType: sniffContentType(entry.name), bytes: readFileSync(nextAbs) });
			}
			// Symlinks and specials are skipped: a snapshot carries plain files.
		}
	};
	walk(dir, '');
	return files;
}

function printExplainer(issue: IssueDetail, ex: DispatchExplainer): void {
	console.log(`${issue.project_name}/#${issue.number}  ${issue.title}`);
	console.log(`\n${ex.verdict}\n`);
	table(ex.checks.map((c) => [`  ${c.ok ? 'ok' : 'FAIL'}`, c.name.replaceAll('_', ' '), c.detail]));
	if (ex.pin) {
		console.log(
			`\npinned to ${ex.pin.runner_name ?? ex.pin.runner_id}${ex.pin.tier ? `:${ex.pin.tier}` : ''} (replaces rule matching)`
		);
	} else if (ex.matched_rule) {
		console.log(`\nmatched rule: ${ex.matched_rule.scope_label}`);
	}
	if (ex.targets.length > 0) {
		console.log('targets (preference order):');
		table(
			ex.targets.map((t) => [
				`  ${t.runner_name}`,
				`${t.tier} → ${t.model ?? '(model n/a)'}`,
				t.verdict === 'ok' ? 'available' : t.verdict.replaceAll('_', ' '),
				t.verdict === 'ok' ? '' : t.detail
			])
		);
	}
	if (ex.queue_position !== null && ex.queue_position > 0) {
		console.log(`queue: ${ex.queue_position} eligible issue${ex.queue_position === 1 ? '' : 's'} ahead of this one`);
	}
	if (ex.active_run) {
		console.log(
			`active run: ${ex.active_run.id} on ${ex.active_run.runner_name} (${ex.active_run.status})`
		);
	}
	if (ex.parked) {
		console.log(
			`parked after ${ex.attempt_count}/${ex.attempt_limit} strikes — \`tines issues resume\` (or any manual transition) revives it`
		);
	}
}

export function register(program: Command): void {
	const issues = program.command('issues').description('Work with issues');

	withList(
		issues
			.command('list')
			.description('List issues across projects (hides done issues unless --all)')
			.option('-p, --project <name>', 'filter by project name or id')
			.option('-s, --state <name>', 'filter by state name or id')
			.option('-c, --category <cat>', 'filter by state category')
			.option('-w, --workflow <id-or-name>', 'filter by workflow')
			.option('-a, --all', 'include issues in done states')
			.option('--ready', 'only issues that are actionable now (not done, not a duplicate, no open blockers)')
			.option('-q, --search <text>', 'search titles and descriptions')
	).action(
		async (
			opts: ListOpts & {
				project?: string;
				state?: string;
				category?: StateCategory;
				workflow?: string;
				all?: boolean;
				ready?: boolean;
				search?: string;
			}
		) => {
			const res = await client(opts).listIssues({
				project: opts.project,
				state: opts.state,
				category: opts.category,
				workflow: opts.workflow,
				hide_done: !opts.all,
				ready: opts.ready,
				q: opts.search,
				limit: opts.limit,
				cursor: opts.cursor
			});
			printList(res, opts, (items) => {
				if (items.length === 0) return console.log(opts.ready ? 'no ready issues' : 'no issues');
				table([
					['REF', 'TITLE', 'STATE', 'CATEGORY', 'LAST ACTIVITY', ''],
					...items.map((i) => [
						`${i.project_name}/${i.number}`,
						i.title,
						// Duplicates display their canonical issue's state, so lists
						// (and the filters above) go by the effective state.
						i.effective_state.name,
						i.effective_state.category,
						timestamp(i.last_activity_at),
						[i.open_blockers.length > 0 ? 'blocked' : '', i.duplicate_of ? 'dup' : '']
							.filter(Boolean)
							.join(' ')
					])
				]);
			});
		}
	);

	withCommon(
		issues
			.command('create <project>')
			.description('Create an issue in a project, optionally with a recurrence (a scheduled task)')
			.requiredOption('-t, --title <title>', 'issue title (doubles as the title template with a recurrence)')
			.option('-d, --description <markdown>', 'issue description (Markdown)')
			.option('-w, --workflow <id-or-name>', 'workflow (defaults to project default, else standard)')
			.option('-s, --state <name>', "starting state (defaults to the workflow's initial state)")
			.option('--every <preset>', 'repeat hourly (or every N hours: "6h"), daily, weekly, or monthly')
			.option('--at <when>', 'preset time of day HH:MM (default 09:00); for hourly, the minute past the hour :MM (default :00)')
			.option('--on <when>', 'weekday (weekly) or day of month (monthly)')
			.option('--cron <expr>', '5-field cron expression (alternative to --every/--at/--on)')
			.option('--tz <iana>', 'schedule timezone (defaults to the system timezone)')
			.option('--if-closed', 'only create a new instance when all previous instances are closed')
			.option('--schedule-name <name>', 'schedule name, unique per project (defaults to the title)')
	).action(
		async (
			projectRef: string,
			opts: CommonOpts &
				RecurrenceOpts & {
					title: string;
					description?: string;
					workflow?: string;
					state?: string;
					ifClosed?: boolean;
					scheduleName?: string;
				}
		) => {
			const api = client(opts);
			const project = await resolveProject(api, projectRef);
			const workflowId = opts.workflow ? (await resolveWorkflow(api, opts.workflow)).id : undefined;
			const recurrence = buildRecurrence(opts);
			if (!recurrence && (opts.ifClosed !== undefined || opts.scheduleName !== undefined)) {
				die('--if-closed/--schedule-name need a recurrence: add --every … or --cron "<expr>"');
			}
			const schedule: CreateScheduleInput | undefined = recurrence
				? {
						...recurrence,
						name: opts.scheduleName,
						timezone: opts.tz ?? systemTimezone(),
						require_all_closed: opts.ifClosed ?? false
					}
				: undefined;
			const issue = await api.createIssue(project.id, {
				title: opts.title,
				description: opts.description,
				workflow_id: workflowId,
				state: opts.state,
				schedule
			});
			if (opts.json) return printJson(issue);
			console.log(
				`created ${issue.project_name}/#${issue.number} "${issue.title}" in state "${issue.state.name}"`
			);
			if (issue.schedule) {
				console.log(
					`created schedule "${issue.project_name}/${issue.schedule.name}": ${recurrenceLabel(issue.schedule)} — next run ${timestamp(issue.schedule.next_run_at)}`
				);
			}
		}
	);

	withCommon(
		issues
			.command('show <ref>')
			.description('Show an issue (<project>/<number>), including allowed transitions')
	).action(async (ref: string, opts: CommonOpts) => {
		const issue = await resolveIssue(client(opts), ref);
		if (opts.json) return printJson(issue);
		printIssueDetail(issue);
	});

	withCommon(
		issues
			.command('edit <ref>')
			.description('Edit an issue: title, description, workflow, or force-set state')
			.option('-t, --title <title>', 'set the title')
			.option('-d, --description <markdown>', 'set the description (Markdown)')
			.option(
				'-s, --state <name>',
				"force-set the state, bypassing the workflow's transitions (records a forced move)"
			)
			.option('-w, --workflow <id-or-name>', 'move the issue onto another workflow')
	).action(
		async (
			ref: string,
			opts: CommonOpts & { title?: string; description?: string; state?: string; workflow?: string }
		) => {
			const api = client(opts);
			const issue = await resolveIssue(api, ref);
			const body: UpdateIssueRequest = {};
			if (opts.title !== undefined) body.title = opts.title;
			if (opts.description !== undefined) body.description = opts.description;
			if (opts.state !== undefined) body.state = opts.state;
			if (opts.workflow !== undefined) body.workflow_id = (await resolveWorkflow(api, opts.workflow)).id;
			if (Object.keys(body).length === 0) {
				die('nothing to update: pass --title, --description, --state, and/or --workflow');
			}
			const updated = await api.updateIssue(issue.id, body);
			if (opts.json) return printJson(updated);
			const notes: string[] = [];
			if (body.title !== undefined) notes.push(`title "${updated.title}"`);
			if (body.description !== undefined) notes.push('description');
			if (body.workflow_id !== undefined) notes.push(`workflow "${updated.workflow.name}"`);
			if (updated.state.id !== issue.state.id) {
				notes.push(`state ${issue.state.name} → ${updated.state.name}`);
			}
			console.log(`updated ${updated.project_name}/#${updated.number}: ${notes.join(', ')}`);
		}
	);

	withCommon(
		issues
			.command('move <ref> <action>')
			.description('Take a transition on an issue by its action name (e.g. "approve")')
	).action(async (ref: string, action: string, opts: CommonOpts) => {
		const api = client(opts);
		const issue = await resolveIssue(api, ref);
		const moved = await api.transitionIssue(issue.id, { action });
		if (opts.json) return printJson(moved);
		console.log(
			`${moved.project_name}/#${moved.number}: ${issue.state.name} → ${moved.state.name} ("${action}")`
		);
	});

	withCommon(
		issues
			.command('comment <ref> <markdown>')
			.description('Comment on an issue (Markdown body)')
			// A body may start with "-"; options go before the arguments.
			.passThroughOptions()
	).action(async (ref: string, markdown: string, opts: CommonOpts, command: Command) => {
		if (helpGuard(command, markdown)) return;
		const api = client(opts);
		const issue = await resolveIssue(api, ref);
		const comment = await api.createComment(issue.id, { body: markdown });
		if (opts.json) return printJson(comment);
		console.log(`commented on ${issue.project_name}/#${issue.number} as ${actorLabel(comment.actor)}`);
	});

	// Links read as sentences: `block A B` means "A blocks B", `duplicate A B`
	// means "A is a duplicate of B". Link ids never surface — the un- commands
	// look the removal up on the issue's own detail.

	withCommon(
		issues
			.command('block <blocker> <blocked>')
			.description('Record that <blocker> blocks <blocked> (advisory: transitions stay allowed)')
	).action(async (blockerRef: string, blockedRef: string, opts: CommonOpts) => {
		const api = client(opts);
		const blocker = await resolveIssue(api, blockerRef);
		const blocked = await resolveIssue(api, blockedRef);
		const link = await api.addIssueLink(blocked.id, { kind: 'blocked_by', issue_id: blocker.id });
		if (opts.json) return printJson(link);
		console.log(
			`${blocker.project_name}/#${blocker.number} now blocks ${blocked.project_name}/#${blocked.number} "${blocked.title}"`
		);
	});

	withCommon(
		issues.command('unblock <blocker> <blocked>').description('Remove the link making <blocker> block <blocked>')
	).action(async (blockerRef: string, blockedRef: string, opts: CommonOpts) => {
		const api = client(opts);
		const blocker = await resolveIssue(api, blockerRef);
		const blocked = await resolveIssue(api, blockedRef);
		const link = blocked.links.blocked_by.find((l) => l.issue_id === blocker.id);
		if (!link) {
			die(
				`${blocked.project_name}/#${blocked.number} is not blocked by ${blocker.project_name}/#${blocker.number}` +
					` (blocked by: ${blocked.links.blocked_by.map(issueRef).join(', ') || 'nothing'})`
			);
		}
		await api.removeIssueLink(blocked.id, link.link_id);
		if (opts.json) return printJson({ removed: link });
		console.log(
			`${blocker.project_name}/#${blocker.number} no longer blocks ${blocked.project_name}/#${blocked.number}`
		);
	});

	withCommon(
		issues
			.command('duplicate <ref> <canonical>')
			.alias('dupe')
			.description('Mark <ref> as a duplicate of <canonical> (its state then follows <canonical>)')
	).action(async (ref: string, canonicalRef: string, opts: CommonOpts) => {
		const api = client(opts);
		const issue = await resolveIssue(api, ref);
		const canonical = await resolveIssue(api, canonicalRef);
		const link = await api.addIssueLink(issue.id, { kind: 'duplicate_of', issue_id: canonical.id });
		if (opts.json) return printJson(link);
		console.log(
			`${issue.project_name}/#${issue.number} is now a duplicate of ${canonical.project_name}/#${canonical.number} "${canonical.title}" — showing its state (${canonical.effective_state.name})`
		);
	});

	withCommon(
		issues
			.command('context <ref>')
			.description("Print an issue's effective context (the assembled bundle for its current state)")
			.option('--out <dir>', 'write the bundle to a directory: prompt.md, skills/<name>/…, repos.json')
			.option('--force', 'allow --out into a non-empty directory')
	).action(async (ref: string, opts: CommonOpts & { out?: string; force?: boolean }) => {
		const api = client(opts);
		const issue = await resolveIssue(api, ref);
		const context = await api.getIssueContext(issue.id);
		if (opts.json && !opts.out) return printJson(context);
		if (opts.out === undefined) {
			if (context.prompt.text) console.log(context.prompt.text);
			if (context.skills.length > 0) {
				console.log(`\nskills: ${context.skills.map((s) => s.name).join(', ')}`);
			}
			for (const repo of context.repos) {
				console.log(`repo: ${repo.name} ${repo.url}${repo.branch ? `#${repo.branch}` : ''} → ${repo.dir}/`);
			}
			for (const o of context.overridden) {
				console.log(`overridden: ${o.kind} "${o.name}" [${o.scope.label}] (overridden by ${o.overridden_by})`);
			}
			for (const c of context.conflicts) {
				console.log(`conflict: repos ${c.item_ids.join(', ')} all resolve to checkout dir "${c.dir}"`);
			}
			return;
		}
		// --out: the workspace-seeding shape. Conflicting checkout dirs make the
		// bundle ambiguous, so refuse entirely while any are reported.
		if (context.conflicts.length > 0) {
			die(
				`refusing to write: checkout-directory conflict${context.conflicts.length === 1 ? '' : 's'} among the effective repos (${context.conflicts
					.map((c) => `"${c.dir}": ${c.item_ids.join(', ')}`)
					.join('; ')}); rename or re-dir the items first`
			);
		}
		if (existsSync(opts.out) && readdirSync(opts.out).length > 0 && !opts.force) {
			die(`refusing to write into non-empty directory ${opts.out} (pass --force to override)`);
		}
		mkdirSync(opts.out, { recursive: true });
		writeFileSync(join(opts.out, 'prompt.md'), context.prompt.text ? `${context.prompt.text}\n` : '');
		for (const skill of context.skills) {
			for (const file of skill.files) {
				const target = join(opts.out, 'skills', skill.name, file.path);
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, file.content);
			}
		}
		writeFileSync(join(opts.out, 'repos.json'), `${JSON.stringify(context.repos, null, 2)}\n`);
		console.log(
			`wrote ${opts.out}/prompt.md, ${context.skills.length} skill${context.skills.length === 1 ? '' : 's'}, repos.json (${context.repos.length} repo${context.repos.length === 1 ? '' : 's'})`
		);
	});

	withCommon(
		issues
			.command('unduplicate <ref>')
			.alias('undupe')
			.description('Unmark a duplicate (its own state was never changed, so it simply reappears)')
	).action(async (ref: string, opts: CommonOpts) => {
		const api = client(opts);
		const issue = await resolveIssue(api, ref);
		const link = issue.links.duplicate_of;
		if (!link) die(`${issue.project_name}/#${issue.number} is not marked as a duplicate`);
		await api.removeIssueLink(issue.id, link.link_id);
		if (opts.json) return printJson({ removed: link });
		console.log(
			`${issue.project_name}/#${issue.number} is no longer a duplicate of ${issueRef(link)} — state ${issue.state.name} (${issue.state.category})`
		);
	});

	withCommon(
		issues
			.command('prompt <ref>')
			.description('Print the launch prompt: the stitched context followed by the issue block')
	).action(async (ref: string, opts: CommonOpts) => {
		const api = client(opts);
		const issue = await resolveIssue(api, ref);
		const prompt = await api.getIssuePrompt(issue.id);
		if (opts.json) return printJson(prompt);
		console.log(prompt.text);
	});

	// --- issue artifacts ---------------------------------------------------------
	// Work products attached along the way — files, text documents, links, PR
	// references — versioned, and the currency that workflow transition
	// requirements gate on (specs/artifacts/SPEC.md).

	const artifactsCmd = issues
		.command('artifacts')
		.description('Typed, versioned attachments on an issue — the work products transition requirements gate on');

	withCommon(artifactsCmd.command('list <ref>').description('List the artifacts attached to an issue')).action(
		async (ref: string, opts: CommonOpts) => {
			const api = client(opts);
			const issue = await resolveIssue(api, ref);
			const res = await api.listArtifacts(issue.id);
			if (opts.json) return printJson(res);
			if (res.items.length === 0) return console.log('no artifacts attached');
			table([
				['NAME', 'TYPE', 'VERSION', 'FRESH', 'SUMMARY', 'ATTACHED'],
				...res.items.map((a) => [
					a.name,
					a.artifact_type,
					`v${a.current_version.version}`,
					a.fresh ? 'yes' : 'no',
					artifactSummary(a),
					timestamp(a.current_version.created_at)
				])
			]);
		}
	);

	withCommon(
		artifactsCmd.command('show <ref> <name>').description('Show an artifact with its full version history')
	).action(async (ref: string, name: string, opts: CommonOpts) => {
		const api = client(opts);
		const issue = await resolveIssue(api, ref);
		const artifact = await api.getArtifact(issue.id, name);
		if (opts.json) return printJson(artifact);
		console.log(`${artifact.artifact_type} artifact "${artifact.name}" on ${issue.project_name}/${issue.number}`);
		if (artifact.description) console.log(artifact.description);
		console.log(
			`current: v${artifact.current_version.version} (${artifact.fresh ? 'fresh' : 'attached before the current state — reaffirm or attach a new version to satisfy gates'})`
		);
		console.log(`summary: ${artifactSummary(artifact)}`);
		console.log('\nversions:');
		table(
			artifact.versions.map((v) => [
				`  v${v.version}`,
				timestamp(v.created_at),
				actorLabel(v.actor),
				v.reaffirmed_from !== null
					? `reaffirmed v${v.reaffirmed_from}`
					: v.file_count !== null
						? `${v.file_count} file${v.file_count === 1 ? '' : 's'}`
						: (v.filename ?? v.url ?? (v.pr_repo_url ? prRefLabel(v) : ''))
			])
		);
		const files = artifact.current_version.files;
		if (files && files.length > 0) {
			console.log(`\nfiles (v${artifact.current_version.version}):`);
			table(files.map((f) => [`  ${f.path}`, f.content_type, `${f.size_bytes} bytes`]));
		}
	});

	withCommon(
		artifactsCmd
			.command('attach <ref> <name>')
			.description('Attach content to a named artifact slot (creates it, or appends the next version)')
			.option('-f, --file <path>', 'upload a file (MIME sniffed from the extension)')
			.option(
				'--folder <dir>',
				'snapshot a directory tree as one version (collect locally, attach once; MIME per file sniffed)'
			)
			.option('-t, --text <md|@file>', 'inline text document: inline Markdown or @file')
			.option('--url <url>', 'link: the URL to attach')
			.option('--pr <spec>', 'PR reference: owner/repo#N or a GitHub PR URL')
			.option('--content-type <mime>', 'declared MIME type (with --file or --text)')
			.option('--filename <name>', 'display filename (with --text; defaults to <name>.md)')
			.option('--title <title>', 'display title (with --url)')
			.option('-d, --description <text>', 'artifact description, shown in lists and launch prompts'),
		// --url is the link payload here; the API base comes from TINES_API_URL.
		{ baseUrlFlag: false }
	).action(
		async (
			ref: string,
			name: string,
			opts: CommonOpts & {
				file?: string;
				folder?: string;
				text?: string;
				url?: string;
				pr?: string;
				contentType?: string;
				filename?: string;
				title?: string;
				description?: string;
			}
		) => {
			const api = client({ apiKey: opts.apiKey, json: opts.json });
			const sources = [opts.file, opts.folder, opts.text, opts.url, opts.pr].filter((v) => v !== undefined);
			if (sources.length !== 1) {
				die(
					'pass exactly one content source: --file <path>, --folder <dir>, --text <md|@file>, --url <url>, or --pr <spec>'
				);
			}
			const issue = await resolveIssue(api, ref);
			let artifact: Artifact;
			if (opts.folder !== undefined) {
				if (!existsSync(opts.folder) || !statSync(opts.folder).isDirectory()) {
					die(`--folder needs a directory, got "${opts.folder}"`);
				}
				const files = walkFolder(opts.folder);
				if (files.length === 0) die(`${opts.folder} contains no files to snapshot`);
				artifact = await api.uploadArtifactFolder(issue.id, name, files);
				// The folder endpoint has no description slot; set it alongside.
				if (opts.description !== undefined) {
					artifact = await api.putArtifact(issue.id, name, { description: opts.description });
				}
			} else if (opts.file !== undefined) {
				let bytes: Buffer;
				try {
					bytes = readFileSync(opts.file);
				} catch (err) {
					die(`cannot read ${opts.file}: ${err instanceof Error ? err.message : String(err)}`);
				}
				artifact = await api.uploadArtifactFile(issue.id, name, bytes, {
					filename: opts.filename ?? basename(opts.file),
					contentType: opts.contentType ?? sniffContentType(opts.file)
				});
				// The file endpoint has no description slot; set it alongside.
				if (opts.description !== undefined) {
					artifact = await api.putArtifact(issue.id, name, { description: opts.description });
				}
			} else if (opts.text !== undefined) {
				artifact = await api.putArtifact(issue.id, name, {
					type: 'text',
					content: readBodyValue(opts.text),
					...(opts.filename !== undefined ? { filename: opts.filename } : {}),
					...(opts.contentType !== undefined ? { content_type: opts.contentType } : {}),
					...(opts.description !== undefined ? { description: opts.description } : {})
				});
			} else if (opts.url !== undefined) {
				artifact = await api.putArtifact(issue.id, name, {
					type: 'link',
					url: opts.url,
					...(opts.title !== undefined ? { title: opts.title } : {}),
					...(opts.description !== undefined ? { description: opts.description } : {})
				});
			} else {
				const parsed = parsePrSpec(opts.pr!);
				if (!parsed) {
					die(`--pr takes owner/repo#N or a GitHub PR URL, got "${opts.pr}"`);
				}
				artifact = await api.putArtifact(issue.id, name, {
					type: 'pr',
					pr_repo_url: parsed.repo_url,
					pr_number: parsed.number,
					...(opts.description !== undefined ? { description: opts.description } : {})
				});
			}
			if (opts.json) return printJson(artifact);
			console.log(
				`attached "${artifact.name}" v${artifact.current_version.version} (${artifactSummary(artifact)}) to ${issue.project_name}/${issue.number} — fresh`
			);
		}
	);

	withCommon(
		artifactsCmd
			.command('reaffirm <ref> <name>')
			.description('Bless the current content as fresh (appends a version reusing the same payload)')
	).action(async (ref: string, name: string, opts: CommonOpts) => {
		const api = client(opts);
		const issue = await resolveIssue(api, ref);
		const artifact = await api.reaffirmArtifact(issue.id, name);
		if (opts.json) return printJson(artifact);
		console.log(
			`reaffirmed "${artifact.name}" on ${issue.project_name}/${issue.number}: v${artifact.current_version.version} reaffirms v${artifact.current_version.reaffirmed_from} — fresh as of now`
		);
	});

	withCommon(
		artifactsCmd
			.command('get <ref> <name>')
			.description('Fetch content (current version by default); a link/pr prints its URL')
			.option('--version <n>', 'fetch a specific version from the history', (v) => Number.parseInt(v, 10))
			.option('--out <path>', 'write to this file, or into this directory (keeps the stored filename)')
	).action(
		async (ref: string, name: string, opts: CommonOpts & { version?: number; out?: string }) => {
			const api = client(opts);
			const issue = await resolveIssue(api, ref);
			const artifact = await api.getArtifact(issue.id, name);
			const version =
				opts.version === undefined
					? artifact.current_version
					: artifact.versions.find((v) => v.version === opts.version);
			if (!version) {
				die(
					`artifact "${name}" has no version ${opts.version} (history: v1–v${artifact.current_version.version})`
				);
			}
			if (artifact.artifact_type === 'link' || artifact.artifact_type === 'pr') {
				const url =
					artifact.artifact_type === 'link' ? version.url : `${version.pr_repo_url}/pull/${version.pr_number}`;
				if (opts.json) return printJson({ url });
				return console.log(url);
			}
			if (artifact.artifact_type === 'folder') {
				// A folder writes its whole tree; a single stdout stream can't.
				if (opts.out === undefined) {
					die(`artifact "${name}" is a folder — pass --out <dir> to write its tree`);
				}
				if (existsSync(opts.out) && !statSync(opts.out).isDirectory()) {
					die(`--out for a folder must be a directory, and "${opts.out}" is a file`);
				}
				const files = version.files ?? [];
				let total = 0;
				for (const file of files) {
					const content = await api.getArtifactContent(issue.id, name, {
						version: opts.version,
						path: file.path
					});
					const target = join(opts.out, file.path);
					mkdirSync(dirname(target), { recursive: true });
					writeFileSync(target, Buffer.from(content.bytes));
					total += content.bytes.byteLength;
				}
				return console.log(
					`wrote ${files.length} file${files.length === 1 ? '' : 's'} (${total} bytes) from "${name}" v${version.version} into ${opts.out}/`
				);
			}
			const content = await api.getArtifactContent(issue.id, name, { version: opts.version });
			const bytes = Buffer.from(content.bytes);
			if (opts.out !== undefined) {
				let target = opts.out;
				if (existsSync(target) && statSync(target).isDirectory()) {
					target = join(target, version.filename ?? name);
				}
				writeFileSync(target, bytes);
				return console.log(`wrote ${target} (${bytes.byteLength} bytes, ${content.content_type})`);
			}
			if ((content.content_type ?? '').startsWith('text/')) {
				process.stdout.write(bytes);
				return;
			}
			const target = version.filename ?? name;
			writeFileSync(target, bytes);
			console.log(`wrote ${target} (${bytes.byteLength} bytes, ${content.content_type})`);
		}
	);

	withCommon(
		artifactsCmd
			.command('delete <ref> <name>')
			.description('Delete an artifact — every version and its stored files (history is not recoverable)')
	).action(async (ref: string, name: string, opts: CommonOpts) => {
		const api = client(opts);
		const issue = await resolveIssue(api, ref);
		const artifact = await api.getArtifact(issue.id, name);
		await api.deleteArtifact(issue.id, name);
		console.log(
			`deleted ${artifact.artifact_type} artifact "${name}" from ${issue.project_name}/${issue.number} (${artifact.version_count} version${artifact.version_count === 1 ? '' : 's'})`
		);
	});

	// --- issue pins --------------------------------------------------------------

	withCommon(
		issues
			.command('assign <ref> [runner]')
			.description('Pin an issue to a runner (<runner>[:tier]) — replaces routing rules for it; --clear unpins')
			.option('--clear', 'remove the pin')
	).action(async (ref: string, runnerSpec: string | undefined, opts: CommonOpts & { clear?: boolean }) => {
		const api = client(opts);
		const issue = await resolveIssue(api, ref);
		if (opts.clear) {
			if (runnerSpec !== undefined) die('--clear does not take a runner');
			const updated = await api.updateIssue(issue.id, { pinned_runner_id: null });
			if (opts.json) return printJson(updated);
			return console.log(`unpinned ${updated.project_name}/#${updated.number} — routing rules apply again`);
		}
		if (runnerSpec === undefined) die('pass <runner>[:tier] to pin, or --clear to unpin');
		const { name, tier } = parseTargetSpec(runnerSpec);
		const runner = await resolveRunner(api, name);
		const updated = await api.updateIssue(issue.id, {
			pinned_runner_id: runner.id,
			pinned_tier: tier ?? null
		});
		if (opts.json) return printJson(updated);
		console.log(
			`pinned ${updated.project_name}/#${updated.number} to ${runner.name}${tier ? ` (tier ${tier})` : ''} — only this runner will take it`
		);
	});

	withCommon(
		issues
			.command('dispatch <ref>')
			.description('Explain why an issue is (not) dispatching: eligibility, routing, per-runner verdicts')
	).action(async (ref: string, opts: CommonOpts) => {
		const api = client(opts);
		const issue = await resolveIssue(api, ref);
		const ex = await api.getIssueDispatch(issue.id);
		if (opts.json) return printJson(ex);
		printExplainer(issue, ex);
	});

	withCommon(
		issues
			.command('resume <ref>')
			.description('Un-park an issue: clear needs-attention and reset the attempt count')
	).action(async (ref: string, opts: CommonOpts) => {
		const api = client(opts);
		const issue = await resolveIssue(api, ref);
		const updated = await api.resumeIssue(issue.id);
		if (opts.json) return printJson(updated);
		console.log(
			issue.needs_attention || issue.attempt_count > 0
				? `resumed ${updated.project_name}/#${updated.number} — attempt count reset, back in the pool`
				: `${updated.project_name}/#${updated.number} was not parked — nothing to do`
		);
	});
}
