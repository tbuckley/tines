import { writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { client, printJson, withCommon, type CommonOpts } from '../common.js';

interface InventoryOptions extends CommonOpts {
	out: string;
}

interface ReceiptOptions extends CommonOpts {
	receipt: string;
	verify?: boolean;
}

interface ReleaseOptions extends CommonOpts {
	hold: string;
	confirm: string;
}

export function register(program: Command): void {
	const retirement = program
		.command('state-retirement')
		.description('Inspect historical state-retirement inventory and receipts');

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

	withCommon(
		retirement
			.command('receipt <receipt>')
			.description('Read a durable state-retirement receipt')
			.option('--verify', 'verify exact current targets and journals')
	).action(async (receipt: string, opts: ReceiptOptions) => {
		if (opts.verify) {
			const value = await client(opts).verifyStateRetirementReceipt(receipt);
			if (opts.json) return printJson(value);
			console.log(`Verification: ${value.status}`);
			console.log(`${value.entries.length} target${value.entries.length === 1 ? '' : 's'} checked`);
		} else {
			const value = await client(opts).getStateRetirementReceipt(receipt);
			if (opts.json) return printJson(value);
			console.log(`Receipt: ${value.id}`);
			console.log(
				`${value.cleared_pointers.length} pointers cleared · ${value.copies.length} context copies`
			);
		}
	});

	withCommon(
		retirement
			.command('release <hold>')
			.description('Explicitly release a verified or abandoned operator hold')
			.requiredOption('--confirm <hold>', 'repeat the hold id as owner confirmation')
	).action(async (hold: string, opts: ReleaseOptions) => {
		const value = await client(opts).releaseStateRetirementHold(hold, {
			confirmation: { hold_id: opts.confirm, release: true }
		});
		if (opts.json) return printJson(value);
		console.log(`Hold ${value.hold_id}: ${value.status}`);
	});
}
