import { writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { client, printJson, withCommon, type CommonOpts } from '../common.js';

interface InventoryOptions extends CommonOpts {
	out: string;
}

export function register(program: Command): void {
	const retirement = program
		.command('state-retirement')
		.description('Preserve guidance before state inheritance is retired');

	withCommon(
		retirement
			.command('inventory')
			.description('Write a versioned, read-only inventory for human review')
			.requiredOption('--out <file>', 'write the exact inventory JSON to this file')
	).action(async (opts: InventoryOptions) => {
		const inventory = await client(opts).getStateRetirementInventory();
		writeFileSync(opts.out, `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
		if (opts.json) return printJson(inventory);
		console.log(`Inventory written to ${opts.out}`);
		console.log(`Digest: ${inventory.inventory_digest}`);
		console.log(
			`${inventory.pointers.length} pointer${inventory.pointers.length === 1 ? '' : 's'} · ${inventory.diagnostics.length} blocking diagnostic${inventory.diagnostics.length === 1 ? '' : 's'}`
		);
	});
}
