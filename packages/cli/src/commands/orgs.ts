/**
 * `tines orgs` — organizations, the unit of sharing
 * (specs/packs/ORGANIZATIONS_SPEC.md). Everyone has a personal organization;
 * a shared one has an owner and managers, and everyone in it works in every
 * project in it.
 *
 * Transferring ownership and deleting an organization need a browser session
 * (the API refuses keys with `session_required`), so `transfer` and `delete`
 * only say where to go, and exit 1 because nothing was done. Accepting an
 * invitation is browser-only too: it happens from the emailed link.
 */
import { createInterface } from 'node:readline/promises';
import {
	client,
	die,
	orgLabel,
	printJson,
	resolveOrganization,
	table,
	webUrl,
	withCommon,
	type CommonOpts
} from '../common.js';
import { timestamp } from '../format.js';
import type { OrganizationDetail } from '@tines/shared';
import type { Command } from 'commander';

async function confirm(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = await rl.question(`${question} [y/N] `).catch(() => '');
		return /^y(es)?$/i.test(answer.trim());
	} finally {
		rl.close();
	}
}

/** `--yes` passes, a terminal is asked, anything else (a pipe, an agent) is refused. */
async function confirmOrDie(yes: boolean | undefined, question: string, what: string) {
	if (yes) return;
	if (!process.stdin.isTTY) die(`refusing to ${what} without a confirmation: rerun with --yes`);
	if (!(await confirm(question))) die('aborted');
}

function printOrganization(org: OrganizationDetail): void {
	console.log(`${org.name}  [${org.id}]`);
	console.log(`${org.kind} organization — owner ${org.owner.name}; you are ${org.role}`);
	console.log(`\nmembers (${org.members.length}):`);
	table([
		['  NAME', 'EMAIL', 'ROLE', 'USER ID', 'JOINED'],
		...org.members.map((m) => [
			`  ${m.name}`,
			m.email ?? '-',
			m.role,
			m.user_id,
			timestamp(m.joined_at)
		])
	]);
	// Members are not shown invitations; only owners and managers manage them.
	if (org.role !== 'member') {
		console.log(`\npending invitations (${org.invitations.length}):`);
		if (org.invitations.length === 0) console.log('  none');
		table([
			...(org.invitations.length ? [['  ID', 'EMAIL', 'DELIVERY', 'EXPIRES']] : []),
			...org.invitations.map((i) => [
				`  ${i.id}`,
				i.email,
				i.delivery_status,
				timestamp(i.expires_at)
			])
		]);
	}
	console.log(`\nprojects (${org.projects.length}):`);
	if (org.projects.length === 0) console.log('  none');
	table([
		...(org.projects.length ? [['  NAME', 'ISSUES', 'ID', 'ARCHIVED']] : []),
		...org.projects.map((p) => [
			`  ${p.name}`,
			String(p.issue_count),
			p.id,
			p.archived_at === null ? '-' : timestamp(p.archived_at)
		])
	]);
}

/** Stops a browser-only action: says where to do it, and exits 1. */
function browserOnly(opts: CommonOpts, what: string, path: string): never {
	die(`${what} needs your browser session (API keys are refused): open ${webUrl(opts, path)}`);
}

export function register(program: Command): void {
	const orgs = program
		.command('orgs')
		.description('Organizations: who shares which projects, workflows, labels and context');

	withCommon(
		orgs.command('list').description('List the organizations you are in (and this key reaches)')
	).action(async (opts: CommonOpts) => {
		const res = await client(opts).listOrganizations();
		if (opts.json) return printJson(res);
		if (res.items.length === 0) return console.log('no organizations');
		table([
			['NAME', 'KIND', 'ROLE', 'OWNER', 'MEMBERS', 'PROJECTS', 'ID'],
			...res.items.map((o) => [
				o.name,
				o.kind,
				o.role,
				o.owner.name,
				String(o.member_count),
				String(o.project_count),
				o.id
			])
		]);
	});

	withCommon(
		orgs
			.command('show <org>')
			.description('Show an organization: people and roles, pending invitations, projects')
	).action(async (ref: string, opts: CommonOpts) => {
		const api = client(opts);
		const org = await api.getOrganization((await resolveOrganization(api, ref)).id);
		if (opts.json) return printJson(org);
		printOrganization(org);
	});

	withCommon(
		orgs.command('create <name>').description('Create a shared organization, with you as its owner')
	).action(async (name: string, opts: CommonOpts) => {
		const org = await client(opts).createOrganization({ name });
		if (opts.json) return printJson(org);
		console.log(`created organization "${org.name}" (${org.id})`);
		console.log(`invite people: tines orgs invite ${org.id} <email>`);
	});

	withCommon(
		orgs.command('rename <org> <name>').description('Rename an organization (owner only)')
	).action(async (ref: string, name: string, opts: CommonOpts) => {
		const api = client(opts);
		const org = await resolveOrganization(api, ref);
		const updated = await api.renameOrganization(org.id, {
			name,
			expected_revision: org.revision
		});
		if (opts.json) return printJson(updated);
		console.log(`renamed organization "${org.name}" to "${updated.name}" (${updated.id})`);
	});

	withCommon(
		orgs
			.command('invite <org> <email>')
			.description(
				'Invite someone to a shared organization; they join as a manager of every project in it, from the emailed link'
			)
	).action(async (ref: string, email: string, opts: CommonOpts) => {
		const api = client(opts);
		const org = await resolveOrganization(api, ref);
		if (org.kind === 'personal')
			die(
				`${orgLabel(org)} is a personal organization and cannot be shared; create a shared one with \`tines orgs create <name>\``
			);
		const invite = await api.inviteToOrganization(org.id, { email });
		if (opts.json) return printJson(invite);
		console.log(
			`${invite.delivery_status === 'sent' ? 'Invited' : 'Invitation saved; delivery failed for'} ${invite.email} to ${org.name} [${invite.id}]; expires ${timestamp(invite.expires_at)}`
		);
	});

	withCommon(
		orgs
			.command('cancel-invite <org> <invite-id>')
			.description('Cancel a pending invitation (see `tines orgs show`)')
	).action(async (ref: string, inviteId: string, opts: CommonOpts) => {
		const api = client(opts);
		const org = await resolveOrganization(api, ref);
		const res = await api.cancelOrganizationInvitation(org.id, inviteId);
		if (opts.json) return printJson(res);
		console.log(`canceled invitation ${inviteId} to ${org.name}`);
	});

	withCommon(
		orgs
			.command('remove <org> <user-id-or-email>')
			.description('Remove someone from an organization: their access to every project in it ends')
	).action(async (ref: string, who: string, opts: CommonOpts) => {
		const api = client(opts);
		const org = await api.getOrganization((await resolveOrganization(api, ref)).id);
		const lower = who.toLowerCase();
		const member =
			org.members.find((m) => m.user_id === who) ??
			org.members.find((m) => (m.email ?? '').toLowerCase() === lower);
		if (!member)
			die(
				`no one in ${org.name} has the user id or email "${who}" (have: ${org.members.map((m) => `${m.name} <${m.email ?? '?'}> [${m.user_id}]`).join(', ')})`
			);
		const res = await api.removeOrganizationMember(org.id, member.user_id);
		if (opts.json) return printJson(res);
		console.log(`removed ${member.name} (${member.user_id}) from ${org.name}`);
	});

	withCommon(
		orgs
			.command('leave <org>')
			.description(
				'Leave a shared organization: you lose access to every project in it (the owner must transfer first)'
			)
			.option('-y, --yes', 'skip the confirmation prompt')
	).action(async (ref: string, opts: CommonOpts & { yes?: boolean }) => {
		const api = client(opts);
		const org = await resolveOrganization(api, ref);
		if (org.kind === 'personal') die('a personal organization cannot be left');
		if (org.role === 'owner')
			die(
				`you own ${org.name}: transfer ownership to a manager first, or delete it, in the browser: ${webUrl(opts, `/organizations/${org.id}`)}`
			);
		await confirmOrDie(
			opts.yes,
			`Leave ${org.name}? You lose access to its ${org.project_count} project${org.project_count === 1 ? '' : 's'}.`,
			'leave'
		);
		const res = await api.leaveOrganization(org.id);
		if (opts.json) return printJson(res);
		console.log(`left ${org.name}`);
	});

	withCommon(
		orgs
			.command('transfer <org>')
			.description('Transfer ownership to a manager — browser only; prints where to do it')
	).action(async (ref: string, opts: CommonOpts) => {
		const org = await resolveOrganization(client(opts), ref);
		browserOnly(opts, `transferring ${org.name}`, `/organizations/${org.id}`);
	});

	withCommon(
		orgs
			.command('delete <org>')
			.description('Delete a shared organization — browser only; prints where to do it')
	).action(async (ref: string, opts: CommonOpts) => {
		const org = await resolveOrganization(client(opts), ref);
		browserOnly(opts, `deleting ${org.name}`, `/organizations/${org.id}`);
	});
}
