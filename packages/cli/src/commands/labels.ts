/**
 * `tines labels` — the label library itself. Applying a label to an issue is
 * `tines issues label`; this group is the vocabulary, which run keys cannot
 * touch (it is control-plane fenced server-side).
 */
import { createInterface } from 'node:readline/promises';
import { client, die, printJson, table, withCommon, type CommonOpts } from '../common.js';
import { LABEL_COLORS, type LabelColor } from '@tines/shared';
import type { Command } from 'commander';

/** Validates --color client-side so the error names the whole palette. */
function parseLabelColor(value: string | undefined): LabelColor | undefined {
	if (value === undefined) return undefined;
	if (!(LABEL_COLORS as readonly string[]).includes(value)) {
		die(`unknown color "${value}" — pick one of: ${LABEL_COLORS.join(', ')}`);
	}
	return value as LabelColor;
}

export function register(program: Command): void {
	const labels = program.command('labels').description('Manage the label library');

	withCommon(
		labels.command('list').description('List labels with how many issues carry each')
	).action(async (opts: CommonOpts) => {
		const res = await client(opts).listLabels();
		if (opts.json) return printJson(res);
		if (res.items.length === 0) return console.log('no labels');
		table([
			['NAME', 'COLOR', 'ISSUES', 'ITEMS', 'RULES', 'DESCRIPTION'],
			...res.items.map((l) => [
				l.name,
				l.color,
				String(l.issue_count),
				String(l.context_item_count),
				String(l.routing_rule_count),
				l.description
			])
		]);
	});

	withCommon(
		labels
			.command('create <name>')
			.description('Create a label')
			.option(
				'--color <key>',
				`chip color (${LABEL_COLORS.join(', ')}); defaults to one derived from the name`
			)
			.option('-d, --description <text>', 'what the label means')
	).action(async (name: string, opts: CommonOpts & { color?: string; description?: string }) => {
		const color = parseLabelColor(opts.color);
		const label = await client(opts).createLabel({ name, color, description: opts.description });
		if (opts.json) return printJson(label);
		console.log(`created label "${label.name}" (${label.color})`);
	});

	withCommon(
		labels
			.command('edit <name>')
			.description('Rename or restyle a label')
			.option('--name <new>', 'new name')
			.option('--color <key>', `chip color (${LABEL_COLORS.join(', ')})`)
			.option('-d, --description <text>', 'what the label means')
	).action(
		async (
			name: string,
			opts: CommonOpts & { name?: string; color?: string; description?: string }
		) => {
			if (opts.name === undefined && opts.color === undefined && opts.description === undefined) {
				die('nothing to change: pass --name, --color, or --description');
			}
			const label = await client(opts).updateLabel(name, {
				name: opts.name,
				color: parseLabelColor(opts.color),
				description: opts.description
			});
			if (opts.json) return printJson(label);
			console.log(`updated label "${label.name}" (${label.color})`);
		}
	);

	withCommon(
		labels
			.command('delete <name>')
			.description('Delete a label and detach it from every issue')
			.option('-y, --yes', 'skip the confirmation')
			.option('-f, --force', 'also delete the context items and routing rules scoped to this label')
	).action(async (name: string, opts: CommonOpts & { yes?: boolean; force?: boolean }) => {
		const api = client(opts);
		if (!opts.yes) {
			const existing = (await api.listLabels()).items.find(
				(l) => l.name.toLowerCase() === name.toLowerCase() || l.id === name
			);
			if (!existing) die(`no such label: ${name}`);
			// Scoped items and rules are what --force destroys, so name them
			// before asking rather than after the 422.
			const scoped = [
				`${existing.issue_count} issue${existing.issue_count === 1 ? '' : 's'}`,
				...(existing.context_item_count > 0
					? [
							`${existing.context_item_count} context item${existing.context_item_count === 1 ? '' : 's'}`
						]
					: []),
				...(existing.routing_rule_count > 0
					? [
							`${existing.routing_rule_count} routing rule${existing.routing_rule_count === 1 ? '' : 's'}`
						]
					: [])
			].join(', ');
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			const answer = await rl.question(
				`Delete label "${existing.name}"${opts.force ? ' and everything scoped to it' : ''}? It is on ${scoped}. [y/N] `
			);
			rl.close();
			if (!/^y(es)?$/i.test(answer.trim())) die('aborted');
		}
		const res = await api.deleteLabel(name, opts.force ? { force: true } : {});
		if (opts.json) return printJson(res);
		console.log(
			`deleted label "${name}" (was on ${res.issue_count} issue${res.issue_count === 1 ? '' : 's'})`
		);
		for (const item of res.context_items_deleted) {
			console.log(`  deleted ${item.kind} "${item.name}" (${item.scope_label})`);
		}
		for (const rule of res.routing_rules_deleted) {
			console.log(`  deleted routing rule (${rule.scope_label})`);
		}
	});
}
