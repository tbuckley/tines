/**
 * The supervisor preamble: the directive text prefixed to the stitched
 * `/prompt` output on supervisor launches only — the plain `/prompt` endpoint
 * stays factual (SPEC.md "Workspace setup and launch"). Generated at
 * delivery, per environment: `local` and `claude_managed` ship now; the
 * Gemini variant slots in with its milestone (the differences are the auth
 * story and the bootstrap section).
 *
 * Pure text assembly — no DB, no `$lib` — so any launch path can import it.
 */

/** Which execution environment the run lands in; drives the auth/bootstrap copy. */
export type PreambleVariant = 'local' | 'claude_managed'; // 'gemini_managed' arrives in M4

export interface PreambleInput {
	variant: PreambleVariant;
	runId: string;
	runnerName: string;
	/** `<project>/<number>`. */
	issueRef: string;
	timeoutMinutes: number;
	/** Managed variants: the Tines API base URL the sandbox reaches out to. */
	apiUrl?: string;
	/** Managed variants: repos already mounted into the workspace, by directory. */
	repoDirs?: string[];
	/**
	 * Managed variants: non-secret env items, rendered as `export` lines the
	 * agent runs (the `TINES_API_URL` precedent — the SDK has no plaintext
	 * env channel). Secret items arrive as vault credentials instead.
	 */
	envExports?: { name: string; value: string }[];
	/** Managed variants: names of secret env items delivered through the vault. */
	envSecretNames?: string[];
	/** Current effective skill metadata; file delivery differs by variant. */
	skills?: readonly { name: string; description: string }[];
}

/** Single-quoted POSIX shell literal. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function skillInstructions(input: PreambleInput, resumed: boolean): string[] {
	const skills = input.skills ?? [];
	if (input.variant === 'local') {
		if (skills.length === 0) {
			return resumed
				? [
						'No skills are currently attached. The refreshed `.agents/skills` directory is empty;',
						'do not rely on a prior skill list or skill files from the previous conversation.'
					]
				: [];
		}
		return [
			resumed
				? `The current effective set of ${skills.length} skill${skills.length === 1 ? '' : 's'} replaces the prior attachment set and has been refreshed at \`.agents/skills\`.`
				: `${skills.length} skill${skills.length === 1 ? ' is' : 's are'} attached at \`.agents/skills\` for automatic harness discovery.`,
			'If the harness has not surfaced every attached skill, inspect `.agents/skills/<name>/SKILL.md`.',
			`If that directory or its metadata is unavailable, \`tines issues context ${input.issueRef} --json\` returns the current names, descriptions, and file contents.`
		];
	}

	const lead = resumed
		? 'The current effective skill set below replaces every prior attachment list and cached skill copy.'
		: 'Skills attached to this issue are not pre-seeded in the managed workspace.';
	if (skills.length === 0) {
		return [lead, 'No skills are currently attached; do not rely on a prior list or cached copy.'];
	}
	return [
		lead,
		'',
		...skills.map((skill) => {
			const description = skill.description.replace(/\s+/g, ' ').trim();
			return description
				? `- \`${skill.name}\`: ${description}`
				: `- \`${skill.name}\`: use when the ${skill.name} procedure is relevant.`;
		}),
		'',
		'These files are not automatically seeded. Fetch the current bundle when needed:',
		`\`tines issues context ${input.issueRef} --json\` (or \`GET /api/v1/issues/:id/context\`) lists each skill file with its contents.`
	];
}

/** Environment-specific sections, keyed so future variants replace only these. */
const VARIANTS: Record<
	PreambleVariant,
	{ auth: (input: PreambleInput) => string[]; workspace: (input: PreambleInput) => string[] }
> = {
	local: {
		auth: () => [
			'The runner daemon has set `TINES_API_KEY` (an ephemeral key minted for this run) and',
			'`TINES_API_URL` in your environment, and refreshes the `tines` CLI on your PATH from npm',
			"at launch — the first lines of this run's log record which version you got, and a warning",
			'there means you may be on an older cached copy. The CLI picks both variables up',
			'automatically; raw `curl` against `$TINES_API_URL/api/v1` with',
			'`Authorization: Bearer $TINES_API_KEY` works too. The key is revoked the moment this run',
			'ends — do not write it anywhere.'
		],
		workspace: (input) => [
			'Your working directory is a fresh per-run workspace containing:',
			'',
			'- `prompt.md` — this prompt.',
			'- `.agents/skills/<name>/…` — the files of every skill attached to this issue.',
			'- `repos.json` — the effective repositories, already cloned into the listed `dir`s',
			"  alongside it (with this machine's own git credentials).",
			...(input.skills && input.skills.length > 0 ? ['', ...skillInstructions(input, false)] : [])
		]
	},
	claude_managed: {
		auth: (input) => [
			'`TINES_API_KEY` is in your environment as a vault credential (an ephemeral key minted for',
			`this run; you will see an opaque placeholder — the real value is substituted when a request`,
			`leaves the sandbox). The Tines API base URL is \`${input.apiUrl ?? ''}\` — export it as`,
			'`TINES_API_URL` before using the CLI. The key is revoked the moment this run ends.',
			'',
			'Bootstrap the CLI first: `npm i -g tines`, then `tines` commands work as documented',
			'in the issue block below. If the install is blocked, every CLI command is a thin wrapper',
			`over \`${input.apiUrl ?? ''}/api/v1\` — \`curl\` with \`Authorization: Bearer $TINES_API_KEY\``,
			'is the fallback.'
		],
		workspace: (input) => [
			...(input.repoDirs && input.repoDirs.length > 0
				? [
						'The effective repositories are already cloned into your workspace:',
						'',
						...input.repoDirs.map((dir) => `- \`/workspace/${dir}\``),
						'',
						'Git push and GitHub API calls against them are authenticated for you at the',
						'sandbox boundary — no credentials to configure.'
					]
				: ['No repositories are attached to this issue.']),
			...(input.envExports && input.envExports.length > 0
				? [
						'',
						'Also exported for this run — run these before anything else:',
						'',
						...input.envExports.map((e) => `\`export ${e.name}=${shellQuote(e.value)}\``)
					]
				: []),
			...(input.envSecretNames && input.envSecretNames.length > 0
				? [
						'',
						`Secret environment variables (${input.envSecretNames.map((n) => `\`${n}\``).join(', ')}) are vault credentials: they show as opaque placeholders and are substituted only when a request leaves the sandbox.`
					]
				: []),
			'',
			...skillInstructions(input, false)
		]
	}
};

/**
 * The preamble text: what run this is, how auth works here, where the
 * workspace materials are, and the contract. Prefixed (plus a blank line) to
 * the launch prompt.
 */
export function buildSupervisorPreamble(input: PreambleInput): string {
	const variant = VARIANTS[input.variant];
	const lines = [
		'# Supervisor run',
		'',
		`This is run ${input.runId} on runner "${input.runnerName}" for issue ${input.issueRef};` +
			` it times out after ${input.timeoutMinutes} minutes. The Tines supervisor dispatched you to` +
			' work the issue described at the end of this prompt.',
		'',
		'## Authentication',
		'',
		...variant.auth(input),
		'',
		'## Workspace',
		'',
		...variant.workspace(input),
		'',
		'## The contract',
		'',
		'- Comment progress on the issue as you go — the comment thread is the durable narrative,',
		'  and the next run (or human) starts from it.',
		'- Before finishing, transition the issue with one of its available transitions (listed in',
		'  the issue block below). A run that ends without moving its issue counts as a strike',
		'  against it.',
		'- Work you cannot finish gets a handoff comment — where things stand, what remains, what',
		'  you would do next — and a transition to the appropriate state.'
	];
	return lines.join('\n');
}

/**
 * The reduced preamble a *resumed* run is launched with. The conversation
 * already holds the previous run's preamble — its auth story, its workspace
 * layout, and the whole issue as it stood — so repeating them buys nothing
 * and costs a longer prefix on every later turn. What genuinely changed is
 * the run identity (a new run id, a new key, a new timeout) and, because a
 * send-back usually crosses stages, the contract of the stage the issue is
 * in now. Tom approved carrying the new comments and the current stage
 * contract into the continuation (Tines/362): a strictly steer-only message
 * would drop the Implementation instructions and the current transition
 * gates on exactly the send-back this feature exists for.
 */
export function buildResumePreamble(input: PreambleInput & { previousRunId: string }): string {
	return [
		'# Supervisor run (resumed)',
		'',
		`You are resuming your own previous session. This is run ${input.runId} on runner` +
			` "${input.runnerName}" for issue ${input.issueRef}; it times out after` +
			` ${input.timeoutMinutes} minutes. It continues run ${input.previousRunId}, whose`,
		'workspace you are still in and whose conversation you are still holding — the repositories,',
		'the files you edited outside the generated skill tree, and everything you learned are retained.',
		'',
		'What follows is only what changed while you were away, plus the contract of the stage the',
		'issue is in now. Everything else — authentication, the workspace layout, the rest of the',
		'issue — is unchanged from your previous prompt; re-read it there rather than asking for it',
		'again.',
		'',
		...skillInstructions(input, true),
		'',
		...(input.variant === 'claude_managed'
			? [
					// Managed: the key moves by rotating the vault credential this
					// session already reads, not by a new process env — and whether
					// the running session re-reads it is the provider's business, so
					// say what to do if it has not, rather than asserting it has.
					"Your API key is new: this run's key has replaced the previous one in the credential",
					'your session reads `TINES_API_KEY` from, and the previous key is revoked. If a `tines`',
					'call fails as unauthenticated, re-read the variable before doing anything else.'
				]
			: [
					'Your API key is new: `TINES_API_KEY` in your environment has been replaced with this',
					"run's key, and the previous one is revoked."
				]),
		'',
		'## The contract',
		'',
		'- Comment progress on the issue as you go — the comment thread is the durable narrative,',
		'  and the next run (or human) starts from it.',
		'- Before finishing, transition the issue with one of its available transitions (listed',
		'  below). A run that ends without moving its issue counts as a strike against it.',
		'- Work you cannot finish gets a handoff comment — where things stand, what remains, what',
		'  you would do next — and a transition to the appropriate state.'
	].join('\n');
}
