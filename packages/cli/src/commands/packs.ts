/**
 * `tines packs` — packs in a project (specs/packs/MVP_SPEC.md): validate a
 * pack folder offline, install, replace, export, and set input values.
 *
 * Install and replace follow the spec's prepare → confirm → receipt shape:
 * the review is fetched once, printed, confirmed (`--yes`, or a prompt on a
 * terminal), and the confirmation carries the reviewed digest, so the server
 * refuses anything other than what was reviewed. The upload sent to confirm
 * is the very bytes sent to prepare: the pack is read from disk once.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
	normalizePackFiles,
	packFolderName,
	writePackArchive,
	type ApiClient,
	type PackFile,
	type PackInputValueInput,
	type PackInputView,
	type PackReview,
	type PackSummary,
	type PackUpload,
	type Project
} from '@tines/shared';
import type { Command } from 'commander';
import {
	client,
	collect,
	die,
	printJson,
	resolveProject,
	resolveWorkflow,
	table,
	withCommon,
	type CommonOpts
} from '../common.js';
import {
	checkInputFlag,
	formatPackDetail,
	formatPackReview,
	formatRemovePreview,
	formatValidation,
	inputLines,
	packBadges,
	parseLocalPack,
	parseScheduleFlag,
	parseWorkflowRef,
	pickPack,
	readLocalPack,
	repoValue,
	sourceLabel,
	splitAssignment
} from '../packs.js';

// ---------------------------------------------------------------------------
// Prompts

async function confirm(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = await rl.question(`${question} [y/N] `).catch(() => '');
		return /^y(es)?$/i.test(answer.trim());
	} finally {
		rl.close();
	}
}

/**
 * A confirmation gate: `--yes` passes, a terminal is asked, and anything
 * else (a pipe, an agent) is refused rather than guessed at.
 */
async function confirmOrDie(yes: boolean | undefined, question: string, what: string) {
	if (yes) return;
	if (!process.stdin.isTTY)
		die(
			`refusing to ${what} without a confirmation: rerun with --yes (review first with --dry-run)`
		);
	if (!(await confirm(question))) die('aborted');
}

/** Reads a line from the terminal without echoing it. */
function readHidden(prompt: string): Promise<string> {
	const stdin = process.stdin;
	if (!stdin.isTTY) die('a secret prompt needs a terminal; pipe the value with --secret-stdin');
	process.stderr.write(prompt);
	return new Promise((resolvePromise) => {
		let value = '';
		const done = () => {
			stdin.setRawMode(false);
			stdin.pause();
			stdin.off('data', onData);
			process.stderr.write('\n');
		};
		const onData = (chunk: Buffer) => {
			for (const ch of chunk.toString('utf8')) {
				if (ch === '\r' || ch === '\n' || ch === '\u0004') {
					done();
					return resolvePromise(value);
				}
				if (ch === '\u0003') {
					done();
					process.exit(130);
				}
				if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
				else value += ch;
			}
		};
		stdin.setRawMode(true);
		stdin.resume();
		stdin.on('data', onData);
	});
}

function readStdinValue(what: string): string {
	const value = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
	if (!value) die(`no ${what} on stdin`);
	return value;
}

// ---------------------------------------------------------------------------
// Resolution

async function resolvePack(
	api: ApiClient,
	projectRef: string,
	packRef: string
): Promise<{ project: Project; pack: PackSummary }> {
	const project = await resolveProject(api, projectRef);
	const { items } = await api.listPacks(project.id);
	return { project, pack: pickPack(items, packRef) };
}

/**
 * A workflow input's value: `pack:<workflow>[/<state>]` passes through (the
 * server binds it to this pack's own workflow); anything else is a workflow
 * id (`wf_…`) or name usable in the project, with an optional state id or
 * name after a `/`.
 */
async function workflowValue(
	api: ApiClient,
	projectId: string,
	raw: string,
	packWorkflows: { key: string; states: { key: string }[] }[] | null
): Promise<PackInputValueInput> {
	const ref = parseWorkflowRef(raw);
	if (ref.kind === 'pack') {
		if (packWorkflows) {
			const wf = packWorkflows.find((w) => w.key === ref.workflow);
			if (!wf)
				die(
					`"${raw}": this pack has no workflow "${ref.workflow}" (have: ${packWorkflows.map((w) => w.key).join(', ') || 'none'})`
				);
			if (ref.state && !wf.states.some((s) => s.key === ref.state))
				die(`"${raw}": workflow "${ref.workflow}" has no state "${ref.state}"`);
		}
		return { workflow_id: ref.ref };
	}
	if (/^wf_[A-Za-z0-9]+$/.test(ref.workflow) && (!ref.state || /^wfs_/.test(ref.state)))
		return { workflow_id: ref.workflow, state_id: ref.state };
	const workflow = await resolveWorkflow(api, ref.workflow, projectId);
	if (!ref.state) return { workflow_id: workflow.id, state_id: null };
	const state =
		workflow.states.find((s) => s.id === ref.state) ??
		workflow.states.find((s) => s.name === ref.state);
	if (!state)
		die(
			`workflow "${workflow.name}" has no state "${ref.state}" (have: ${workflow.states.map((s) => s.name).join(', ')})`
		);
	return { workflow_id: workflow.id, state_id: state.id };
}

// ---------------------------------------------------------------------------
// Value flags (install and replace)

interface ValueFlagOpts {
	value: string[];
	repo: string[];
	workflow: string[];
	secret: string[];
	secretStdin?: string;
}

function withValueFlags(cmd: Command): Command {
	return cmd
		.option('--value <name=text>', 'set a text input (repeatable)', collect, [])
		.option('--repo <name=url[#branch]>', 'set a repo input (repeatable)', collect, [])
		.option(
			'--workflow <name=ref>',
			'set a workflow input to a workflow id or name ([/<state>]), or pack:<workflow>[/<state>] for one of this pack (repeatable)',
			collect,
			[]
		)
		.option(
			'--secret <name>',
			'set your own value for a secret input, typed at a hidden prompt (repeatable)',
			collect,
			[]
		)
		.option('--secret-stdin <name>', 'set your own value for one secret input, read from stdin');
}

async function collectValues(
	api: ApiClient,
	projectId: string,
	review: PackReview,
	opts: ValueFlagOpts
): Promise<{
	values: Record<string, PackInputValueInput>;
	secrets: Record<string, string>;
	set: Set<string>;
}> {
	const inputs = review.inputs;
	const values: Record<string, PackInputValueInput> = {};
	const secrets: Record<string, string> = {};
	const set = new Set<string>();
	const once = (name: string, flag: string) => {
		if (set.has(name)) die(`${flag} ${name}: input "${name}" is set twice`);
		set.add(name);
	};
	for (const raw of opts.value) {
		const [name, text] = splitAssignment(raw, '--value', '<name>=<text>');
		checkInputFlag(inputs, name, '--value');
		once(name, '--value');
		values[name] = { text };
	}
	for (const raw of opts.repo) {
		const [name, value] = splitAssignment(raw, '--repo', '<name>=<url>[#<branch>]');
		checkInputFlag(inputs, name, '--repo');
		once(name, '--repo');
		values[name] = repoValue(value);
	}
	const packWorkflows = review.model?.workflows ?? null;
	for (const raw of opts.workflow) {
		const [name, value] = splitAssignment(raw, '--workflow', '<name>=<workflow>');
		checkInputFlag(inputs, name, '--workflow');
		once(name, '--workflow');
		values[name] = await workflowValue(api, projectId, value, packWorkflows);
	}
	for (const name of opts.secret) checkInputFlag(inputs, name, '--secret');
	if (opts.secretStdin) checkInputFlag(inputs, opts.secretStdin, '--secret-stdin');
	if (opts.secretStdin) {
		once(opts.secretStdin, '--secret-stdin');
		secrets[opts.secretStdin] = readStdinValue(`value for ${opts.secretStdin}`);
	}
	for (const name of opts.secret) {
		once(name, '--secret');
		const value = await readHidden(`Your value for secret input "${name}": `);
		if (value) secrets[name] = value;
	}
	return { values, secrets, set };
}

/** Inputs still missing after this invocation's flags, for the needs-setup note. */
function stillMissing(inputs: PackInputView[], set: Set<string>): string[] {
	return inputs.filter((i) => i.missing && !set.has(i.name)).map((i) => i.name);
}

/** Stops before any confirm call when the review cannot be confirmed from here. */
function assertConfirmable(review: PackReview, action: 'install' | 'replace') {
	if (review.errors.length || review.requires_browser) console.error(formatPackReview(review));
	if (review.errors.length) {
		die(`the pack has ${review.errors.length} error(s); fix them and run \`tines packs validate\``);
	}
	if (review.requires_browser) {
		die(
			`this pack has states whose run_scope reaches past their own issue (project or organization)${action === 'replace' ? ', or this version widens one' : ''}. Only a person in the browser can confirm that: ${action} it from the web UI (Project → Packs → ${action === 'install' ? 'Install' : 'Replace'}). An API key cannot.`
		);
	}
}

// ---------------------------------------------------------------------------

export function register(program: Command): void {
	const packs = program
		.command('packs')
		.description('Packs: versioned bundles of workflows, context, inputs and suggested schedules');

	// validate is offline: it reads the folder or archive and runs the same
	// validator the server does, so it takes no --url or --api-key.
	packs
		.command('validate <path>')
		.description(
			'Validate a pack folder or .tinespack/.zip locally (no server needed): errors, warnings, digest and a summary'
		)
		.option('--json', 'output the validation result as JSON')
		.action(async (path: string, opts: { json?: boolean }) => {
			const result = await parseLocalPack(readLocalPack(path));
			if (opts.json)
				printJson({
					digest: result.digest,
					errors: result.errors,
					warnings: result.warnings,
					model: result.model,
					files: result.files.map((f) => f.path)
				});
			else console.log(formatValidation(result));
			if (result.errors.length) process.exitCode = 1;
		});

	withCommon(
		packs.command('list <project>').description("List a project's packs, in order")
	).action(async (projectRef: string, opts: CommonOpts) => {
		const api = client(opts);
		const project = await resolveProject(api, projectRef);
		const res = await api.listPacks(project.id);
		if (opts.json) return printJson(res);
		if (res.items.length === 0) return console.log('no packs');
		table([
			['NAME', 'KIND', 'ID', 'PACK ID', 'VERSION', 'SOURCE', 'STATUS'],
			...res.items.map((p) => [
				p.name,
				p.kind,
				p.id,
				p.pack_key,
				p.version === null ? '-' : String(p.version),
				sourceLabel(p),
				packBadges(p).join('; ') || 'ok'
			])
		]);
	});

	withCommon(
		packs
			.command('show <project> <pack>')
			.description(
				'Show a pack: inputs, workflows and states, items by reach, suggested schedules (<pack>: id, pack id or name)'
			)
	).action(async (projectRef: string, packRef: string, opts: CommonOpts) => {
		const api = client(opts);
		const { project, pack } = await resolvePack(api, projectRef, packRef);
		const detail = await api.getPack(project.id, pack.id);
		if (opts.json) return printJson(detail);
		console.log(formatPackDetail(detail));
	});

	withCommon(
		withValueFlags(
			packs
				.command('install <path-or-project> [project]')
				.description(
					'Install a pack from a folder or .tinespack (install <path> <project>), or from another project (install --from <source-pack> <project>)'
				)
				.option(
					'--from <source-pack>',
					'install from a pack in another project (see `packs sources`)'
				)
				.option('--authored', 'install as an editable authored pack instead of read-only')
				.option(
					'--schedule <key[@timezone]>',
					'create this suggested schedule, enabled (repeatable; timezone defaults to the local one)',
					collect,
					[]
				)
				.option('--dry-run', 'print the review and exit without installing')
				.option('-y, --yes', 'skip the confirmation prompt')
		)
	).action(
		async (
			first: string,
			second: string | undefined,
			opts: CommonOpts &
				ValueFlagOpts & {
					from?: string;
					authored?: boolean;
					schedule: string[];
					dryRun?: boolean;
					yes?: boolean;
				}
		) => {
			if (opts.from && second !== undefined)
				die(
					'with --from, pass only the destination project: install --from <source-pack> <project>'
				);
			if (!opts.from && second === undefined)
				die(
					'pass the pack and the project: install <path> <project> (or --from <source-pack> <project>)'
				);
			const projectRef = opts.from ? first : second!;
			const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
			const schedules = opts.schedule.map((s) => parseScheduleFlag(s, timezone));

			const api = client(opts);
			const project = await resolveProject(api, projectRef);
			let source: PackUpload | { source_pack_id: string };
			if (opts.from) {
				const { items } = await api.listPackSources(project.id);
				const candidate =
					items.find((c) => c.pack_id === opts.from) ??
					(() => {
						const matches = items.filter((c) => c.pack_key === opts.from || c.name === opts.from);
						if (matches.length > 1)
							die(
								`source pack "${opts.from}" is ambiguous; use an id: ${matches.map((c) => `${c.name} in ${c.project_name} [${c.pack_id}]`).join(', ')}`
							);
						return matches[0];
					})();
				if (!candidate)
					die(
						`no source pack "${opts.from}" you can read (see \`tines packs sources ${projectRef}\`)`
					);
				source = { source_pack_id: candidate.pack_id };
			} else {
				source = readLocalPack(first).upload;
			}

			const review = await api.prepareInstallPack(project.id, source);
			if (opts.dryRun) {
				if (review.errors.length) process.exitCode = 1;
				if (opts.json) return printJson(review);
				return console.log(formatPackReview(review));
			}
			if (review.already_installed)
				die(
					`pack "${review.model?.manifest.id}" is already in ${project.name} as "${review.already_installed.name}" [${review.already_installed.pack_id}]; use \`tines packs replace\``
				);
			assertConfirmable(review, 'install');
			for (const s of schedules)
				if (!review.model!.schedules.some((m) => m.key === s.key))
					die(
						`--schedule ${s.key}: this pack suggests no schedule "${s.key}" (have: ${review.model!.schedules.map((m) => m.key).join(', ') || 'none'})`
					);

			const { values, secrets, set } = await collectValues(api, project.id, review, opts);
			// Under --json stdout carries exactly one object, so the review goes to stderr.
			const show = opts.json ? console.error : console.log;
			show(formatPackReview(review, { willSet: set }));
			const missing = stillMissing(review.inputs, set);
			if (missing.length)
				show(
					`\nnote: ${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no value; the pack will be installed as needs setup (set later with \`tines packs set-input\`)`
				);
			await confirmOrDie(
				opts.yes,
				`Install ${review.model!.manifest.name} into ${project.name}${opts.authored ? ' as an authored pack' : ''}?`,
				'install'
			);

			const receipt = await api.installPack(project.id, {
				...source,
				expected_digest: review.digest,
				...(opts.authored ? { authored: true } : {}),
				...(Object.keys(values).length ? { values } : {}),
				...(Object.keys(secrets).length ? { my_secrets: secrets } : {}),
				...(schedules.length ? { schedules } : {})
			});
			if (opts.json) return printJson(receipt);
			console.log(
				`installed ${receipt.pack.name} [${receipt.pack.id}] (${receipt.pack.kind}, version ${receipt.version ?? 'none'})`
			);
			for (const s of receipt.schedules_created) console.log(`  created schedule ${s.name}`);
			const badges = packBadges(receipt.pack);
			if (badges.length) console.log(`status: ${badges.join('; ')}`);
		}
	);

	withCommon(
		withValueFlags(
			packs
				.command('replace <path-or-project> <project-or-pack> [pack]')
				.description(
					'Replace a pack with a new version: replace <path> <project> <pack>, or replace --from-source <project> <pack>'
				)
				.option('--from-source', 'update from the project the pack was installed from')
				.option(
					'--map <state=target>',
					'map a removed state (id or <workflow>/<state> key) to a target ref from the review (repeatable)',
					collect,
					[]
				)
				.option(
					'--confirm-version',
					'accept a lower version, or the same version with different content'
				)
				.option('--diff', "print each changed file's diff in the review")
				.option('--dry-run', 'print the review and exit without replacing')
				.option('-y, --yes', 'skip the confirmation prompt')
		)
	).action(
		async (
			first: string,
			second: string,
			third: string | undefined,
			opts: CommonOpts &
				ValueFlagOpts & {
					fromSource?: boolean;
					map: string[];
					confirmVersion?: boolean;
					diff?: boolean;
					dryRun?: boolean;
					yes?: boolean;
				}
		) => {
			if (opts.fromSource && third !== undefined)
				die(
					'with --from-source, pass only the project and the pack: replace --from-source <project> <pack>'
				);
			if (!opts.fromSource && third === undefined)
				die('pass the new version, the project and the pack: replace <path> <project> <pack>');
			const [projectRef, packRef] = opts.fromSource ? [first, second] : [second, third!];
			const api = client(opts);
			// Read the file before any request: a bad path fails offline.
			const upload: PackUpload | { from_source: true } = opts.fromSource
				? { from_source: true }
				: readLocalPack(first).upload;
			const { project, pack } = await resolvePack(api, projectRef, packRef);
			const review = await api.prepareReplacePack(project.id, pack.id, upload);
			if (opts.dryRun) {
				if (review.errors.length) process.exitCode = 1;
				if (opts.json) return printJson(review);
				return console.log(formatPackReview(review, { diff: opts.diff }));
			}
			assertConfirmable(review, 'replace');

			const rows = review.state_mapping ?? [];
			const targets = review.mapping_targets ?? [];
			const mapping: Record<string, string> = {};
			for (const raw of opts.map) {
				const [from, to] = splitAssignment(raw, '--map', '<state>=<target>');
				const row = rows.find(
					(r) => r.state_id === from || `${r.workflow_key}/${r.state_key}` === from
				);
				if (!row)
					die(
						`--map ${from}: not a removed state that needs mapping (have: ${rows.map((r) => `${r.workflow_key}/${r.state_key} [${r.state_id}]`).join(', ') || 'none'})`
					);
				if (targets.length && !targets.some((t) => t.ref === to))
					die(
						`--map ${from}=${to}: not a state that exists after the replace (targets: ${targets.map((t) => t.ref).join(', ')})`
					);
				mapping[row.state_id] = to;
			}
			const { values, secrets, set } = await collectValues(api, project.id, review, opts);
			const show = opts.json ? console.error : console.log;
			show(formatPackReview(review, { willSet: set, diff: opts.diff, mapping }));
			const unmapped = rows.filter((r) => !mapping[r.state_id] && !r.suggested);
			if (unmapped.length)
				die(
					`map every removed state that holds issues, additions or schedules: ${unmapped.map((r) => `--map ${r.workflow_key}/${r.state_key}=<target>`).join(' ')}`
				);
			if (review.version_warning && !opts.confirmVersion)
				die(
					review.version_warning === 'lower_version'
						? 'this version is lower than the installed one; pass --confirm-version to replace anyway'
						: 'this version has the same number as the installed one but different content; pass --confirm-version to replace anyway'
				);
			const missing = stillMissing(review.inputs, set);
			if (missing.length)
				show(
					`\nnote: ${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no value; the pack will be left needing setup`
				);
			await confirmOrDie(
				opts.yes,
				`Replace ${pack.name} in ${project.name} with this version?`,
				'replace'
			);

			// Suggested mappings are sent explicitly, so what was reviewed is what applies.
			const stateMapping: Record<string, string> = {};
			for (const r of rows) {
				const to = mapping[r.state_id] ?? r.suggested;
				if (to) stateMapping[r.state_id] = to;
			}
			const receipt = await api.replacePack(project.id, pack.id, {
				...upload,
				expected_digest: review.digest,
				...(opts.confirmVersion ? { confirm_version: true } : {}),
				...(Object.keys(stateMapping).length ? { state_mapping: stateMapping } : {}),
				...(Object.keys(values).length ? { values } : {}),
				...(Object.keys(secrets).length ? { my_secrets: secrets } : {})
			});
			if (opts.json) return printJson(receipt);
			console.log(
				`replaced ${receipt.pack.name} [${receipt.pack.id}]: now version ${receipt.version ?? 'none'}${receipt.issues_moved ? `; ${receipt.issues_moved} issue(s) moved by the state mapping` : ''}`
			);
			const badges = packBadges(receipt.pack);
			if (badges.length) console.log(`status: ${badges.join('; ')}`);
		}
	);

	withCommon(
		packs
			.command('export <project> <pack>')
			.description(
				'Export a pack as a .tinespack (default: the suggested file name, in the current folder) or into a folder'
			)
			.option('-o, --output <file>', 'write the archive here')
			.option('--dir <folder>', 'write the pack as files into this folder instead of an archive')
			.option('--force', 'overwrite an existing file, or write into a non-empty folder')
	).action(
		async (
			projectRef: string,
			packRef: string,
			opts: CommonOpts & { output?: string; dir?: string; force?: boolean }
		) => {
			if (opts.output && opts.dir) die('pass -o <file> or --dir <folder>, not both');
			if (opts.dir && !opts.force && existsSync(opts.dir)) {
				let entries: string[];
				try {
					entries = readdirSync(opts.dir);
				} catch {
					die(`${opts.dir} exists and is not a folder`);
				}
				if (entries.length) die(`${opts.dir} is not empty; pass --force to write into it`);
			}
			if (opts.output && !opts.force && existsSync(opts.output))
				die(`${opts.output} exists; pass --force to overwrite it`);
			const api = client(opts);
			const { project, pack } = await resolvePack(api, projectRef, packRef);
			const out = await api.exportPack(project.id, pack.id);
			const raw: PackFile[] = out.files.map((f) => ({
				path: f.path,
				bytes: new Uint8Array(Buffer.from(f.content_b64, 'base64'))
			}));
			// The server's paths are checked like any pack's before they touch the disk.
			const { files, errors } = normalizePackFiles(raw);
			if (errors.length)
				die(`the export holds unsafe paths: ${errors.map((e) => e.message).join('; ')}`);
			let written: string;
			if (opts.dir) {
				const root = resolve(opts.dir);
				mkdirSync(root, { recursive: true });
				for (const f of files) {
					const target = join(root, f.path);
					mkdirSync(dirname(target), { recursive: true });
					writeFileSync(target, f.bytes);
				}
				written = opts.dir;
			} else {
				written = opts.output ?? out.filename;
				if (!opts.output && !opts.force && existsSync(written))
					die(`${written} exists; pass -o <file>, or --force to overwrite it`);
				writeFileSync(written, writePackArchive(files, packFolderName(out.pack_key)));
			}
			if (opts.json) return printJson({ ...out, files: out.files.map((f) => f.path), written });
			console.log(
				`exported ${out.pack_key} version ${out.version} (${out.new_version ? 'took a new version' : 'same version as before'}) to ${written}`
			);
			console.log(`digest: ${out.digest}`);
		}
	);

	withCommon(
		packs
			.command('create <project> <name>')
			.description('Create a new authored pack in a project')
			.option('-d, --description <text>', 'what the pack is for')
	).action(
		async (projectRef: string, name: string, opts: CommonOpts & { description?: string }) => {
			const api = client(opts);
			const project = await resolveProject(api, projectRef);
			const pack = await api.createPack(project.id, {
				name,
				...(opts.description !== undefined ? { description: opts.description } : {})
			});
			if (opts.json) return printJson(pack);
			console.log(`created authored pack "${pack.name}" [${pack.id}] (pack id ${pack.pack_key})`);
		}
	);

	withCommon(
		packs
			.command('inputs <project> <pack>')
			.description("Show a pack's inputs and this project's values")
	).action(async (projectRef: string, packRef: string, opts: CommonOpts) => {
		const api = client(opts);
		const { project, pack } = await resolvePack(api, projectRef, packRef);
		const detail = await api.getPack(project.id, pack.id);
		if (opts.json) return printJson(detail.inputs);
		if (!detail.inputs.length) return console.log('this pack declares no inputs');
		console.log(inputLines(detail.inputs).join('\n'));
	});

	withCommon(
		packs
			.command('set-input <project> <pack> <name> [value]')
			.description(
				"Set this project's value for an input, typed by the input: text, a repo URL[#branch], or a workflow (id or name[/<state>], or pack:<workflow>[/<state>])"
			)
			.option('--clear', 'remove the value')
	).action(
		async (
			projectRef: string,
			packRef: string,
			name: string,
			value: string | undefined,
			opts: CommonOpts & { clear?: boolean }
		) => {
			if (opts.clear && value !== undefined) die('pass a value or --clear, not both');
			if (!opts.clear && value === undefined) die('pass a value, or --clear to remove it');
			const api = client(opts);
			const { project, pack } = await resolvePack(api, projectRef, packRef);
			const detail = await api.getPack(project.id, pack.id);
			const input = detail.inputs.find((i) => i.name === name);
			if (!input)
				die(
					`this pack declares no input "${name}" (have: ${detail.inputs.map((i) => `${i.name} (${i.decl.type})`).join(', ') || 'none'})`
				);
			let body: PackInputValueInput | null = null;
			if (!opts.clear) {
				switch (input.decl.type) {
					case 'secret':
						return die(
							`"${name}" is a secret input: each person sets their own with \`tines packs set-secret\``
						);
					case 'text':
						body = { text: value! };
						break;
					case 'repo':
						body = repoValue(value!);
						break;
					case 'workflow':
						body = await workflowValue(api, project.id, value!, null);
						break;
				}
			}
			const updated = await api.setPackValues(project.id, pack.id, { [name]: body });
			if (opts.json) return printJson(updated);
			const after = updated.inputs.find((i) => i.name === name);
			console.log(
				after ? inputLines([after]).join('\n') : `${opts.clear ? 'cleared' : 'set'} ${name}`
			);
		}
	);

	withCommon(
		packs
			.command('set-secret <project> <pack> <name>')
			.description(
				'Set your own value for a secret input: typed at a hidden prompt, or read from stdin when piped'
			)
			.option('--clear', 'remove your value')
	).action(
		async (
			projectRef: string,
			packRef: string,
			name: string,
			opts: CommonOpts & { clear?: boolean }
		) => {
			const api = client(opts);
			const { project, pack } = await resolvePack(api, projectRef, packRef);
			const detail = await api.getPack(project.id, pack.id);
			const input = detail.inputs.find((i) => i.name === name);
			if (!input || input.decl.type !== 'secret')
				die(
					`this pack declares no secret input "${name}" (secret inputs: ${
						detail.inputs
							.filter((i) => i.decl.type === 'secret')
							.map((i) => i.name)
							.join(', ') || 'none'
					})`
				);
			let value: string | null = null;
			if (!opts.clear) {
				value = process.stdin.isTTY
					? await readHidden(`Your value for "${name}": `)
					: readStdinValue(`value for ${name}`);
				if (!value) die('empty value; pass --clear to remove yours');
			}
			const updated = await api.setPackMySecrets(project.id, pack.id, { [name]: value });
			if (opts.json) return printJson(updated);
			console.log(`${opts.clear ? 'cleared' : 'set'} your value for ${name} in ${updated.name}`);
		}
	);

	withCommon(
		packs
			.command('detach <project> <pack>')
			.description(
				'Turn an installed pack into an authored one (new pack id; the source is forgotten)'
			)
			.option('-y, --yes', 'skip the confirmation prompt')
	).action(async (projectRef: string, packRef: string, opts: CommonOpts & { yes?: boolean }) => {
		const api = client(opts);
		const { project, pack } = await resolvePack(api, projectRef, packRef);
		if (pack.kind !== 'installed') die(`"${pack.name}" is already an authored pack`);
		await confirmOrDie(
			opts.yes,
			`Detach ${pack.name} (${pack.pack_key}) in ${project.name}? Its versions will no longer replace it.`,
			'detach'
		);
		const detail = await api.detachPack(project.id, pack.id, { expected_revision: pack.revision });
		if (opts.json) return printJson(detail);
		console.log(`detached ${detail.name} [${detail.id}]: now authored, pack id ${detail.pack_key}`);
	});

	withCommon(
		packs
			.command('remove <project> <pack>')
			.description(
				'Remove a pack, its workflows and context, and the project additions on its states (shows what goes first)'
			)
			.option('-y, --yes', 'skip the confirmation prompt')
	).action(async (projectRef: string, packRef: string, opts: CommonOpts & { yes?: boolean }) => {
		const api = client(opts);
		const { project, pack } = await resolvePack(api, projectRef, packRef);
		const preview = await api.getPackRemovePreview(project.id, pack.id);
		const show = opts.json ? console.error : console.log;
		show(`Remove ${pack.name} [${pack.id}] from ${project.name}\n${formatRemovePreview(preview)}`);
		const { issues, schedules } = preview.blocked_by;
		if (issues.length || schedules.length)
			die(
				`${issues.length} issue(s) and ${schedules.length} schedule(s) use this pack's workflows; move them first`
			);
		await confirmOrDie(opts.yes, `Remove ${pack.name}?`, 'remove');
		const result = await api.removePack(project.id, pack.id, {
			expected_revision: pack.revision
		});
		if (opts.json) return printJson(result);
		console.log(
			`removed ${pack.name}: ${result.additions_deleted} project addition(s) deleted, ${result.inputs_unbound} input(s) unbound in other packs`
		);
	});

	withCommon(
		packs
			.command('sources <project>')
			.description('List packs in your other projects that can be installed here (install --from)')
	).action(async (projectRef: string, opts: CommonOpts) => {
		const api = client(opts);
		const project = await resolveProject(api, projectRef);
		const res = await api.listPackSources(project.id);
		if (opts.json) return printJson(res);
		if (!res.items.length) return console.log('no packs in your other projects');
		table([
			['NAME', 'KIND', 'PACK ID', 'VERSION', 'PROJECT', 'SOURCE PACK'],
			...res.items.map((c) => [
				c.name,
				c.kind,
				c.pack_key,
				c.version === null ? '-' : String(c.version),
				c.project_name,
				c.pack_id
			])
		]);
	});
}
