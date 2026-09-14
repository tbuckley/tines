import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const forbidden = [
	/\bdo not (?:preserve|inspect|attach|use root)\b/i,
	/\b(?:skip|omit) scouting\b/i,
	/\b(?:reuse|use) (?:a )?stale (?:proposal|file)\b/i,
	/(?<!never )\bself[- ]approve\b/i,
	/\bignore root\b/i,
	/\bdecision was not to keep exact current bodies\b/i
];

const rules = {
	routine: [
		[/global[\s\S]*title/i, 'global title'],
		[/project p[\s\S]*title[\s\S]*owner/i, 'project title and owner'],
		[/root state[\s\S]*acceptance/i, 'Root acceptance'],
		[/combined[\s\S]*title[\s\S]*acceptance/i, 'combined title and acceptance'],
		[/unspecified[\s\S]*unknown/i, 'unspecified fields stay unknown'],
		[/preserve human decisions/i, 'preserve human decisions'],
		[/preserve source conflicts/i, 'preserve source conflicts'],
		[/never approve your own proposal/i, 'no self-approval']
	],
	conditional: [
		[/global[\s\S]*(?:no project|project (?:unset|restriction|dimension))/i, 'global exact scope'],
		[/project(?: scope| p)?[\s\S]*project\s*=?.?p/i, 'project exact scope'],
		[
			/root state[\s\S]*(?:state\s*=|provenance[^.]*root|brief bound to[^.]*root)/i,
			'Root exact scope'
		],
		[
			/combined[\s\S]*(?:project\s*=?.?p|project p)[\s\S]*(?:state\s*=?.?root|root binding)|project p \+ root[\s\S]*exact scope/i,
			'combined exact scope'
		],
		[/inspect[\s\S]*before (?:any )?(?:state )?movement/i, 'inspection precedes movement'],
		[
			/enter scouting[\s\S]*(?:if|when)[\s\S]*(?:permit|available|legal|support)/i,
			'conditional Scouting'
		],
		[
			/attach[\s\S]*(?:then|only after)[\s\S]*re-propose|before re-propose[\s\S]*attach/i,
			'fresh attachment precedes Re-propose'
		],
		[
			/inheriting child[\s\S]*(?:use|retain|attribute)[\s\S]*root[\s\S]*provenance/i,
			'inherited Root provenance'
		],
		[/never (?:approve your own proposal|self-approve)/i, 'no self-approval']
	],
	old_decision: [
		[/old human decision is:? keep exact current bodies available/i, 'exact old decision'],
		[/tines issues show Fixture\/520 --json/i, 'existing issue read'],
		[/--arg id cmt_old_detail/i, 'comment id binding'],
		[/select\(\.id == \$id\)/i, 'JSON comment selection']
	]
};

export function score(output) {
	return Object.fromEntries(
		Object.entries(rules).map(([key, checks]) => {
			const value = typeof output[key] === 'string' ? output[key] : '';
			const missing = checks.filter(([pattern]) => !pattern.test(value)).map(([, label]) => label);
			const contradictions = forbidden.filter((pattern) => pattern.test(value)).map(String);
			return [
				key,
				{ accepted: missing.length === 0 && contradictions.length === 0, missing, contradictions }
			];
		})
	);
}

function selfTest() {
	const passing = {
		routine:
			'Global title. Project P title and owner. Root state acceptance. Combined title and acceptance. Unspecified fields are unknown. Preserve human decisions. Preserve source conflicts. Never approve your own proposal.',
		conditional:
			'Global project unset. Project scope project=P. Root state state=Root. Combined project=P state=Root. Inspect the target before any state movement. Enter Scouting when a legal transition is available. Attach and verify a fresh proposal; only after the attachment run Re-propose. An inheriting child must use Root provenance. Never self-approve.',
		old_decision:
			"The old human decision is: keep exact current bodies available. tines issues show Fixture/520 --json | jq -er --arg id cmt_old_detail 'first(.comments[] | select(.id == $id))'"
	};
	const reversed = {
		...passing,
		conditional: `${passing.conditional} Do not inspect. Skip Scouting, reuse a stale proposal, self-approve, and ignore Root.`,
		old_decision: `${passing.old_decision} The decision was not to keep exact current bodies.`
	};
	if (Object.values(score(passing)).some((result) => !result.accepted))
		throw new Error(`known-pass control failed: ${JSON.stringify(score(passing))}`);
	if (score(reversed).conditional.accepted || score(reversed).old_decision.accepted)
		throw new Error('known-fail semantic reversal was accepted');
	process.stdout.write('semantic controls pass\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (process.argv[2] === '--self-test') selfTest();
	else {
		const file = process.argv[2];
		if (!file) throw new Error('usage: node check.mjs <output.json> | --self-test');
		const acceptance = score(JSON.parse(readFileSync(file, 'utf8')));
		process.stdout.write(`${JSON.stringify(acceptance, null, 2)}\n`);
		if (Object.values(acceptance).some((result) => !result.accepted)) process.exitCode = 1;
	}
}
