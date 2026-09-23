import { readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { client, printJson, withCommon, type CommonOpts } from '../common.js';

interface InventoryOptions extends CommonOpts {
	out: string;
}

interface HoldOptions extends CommonOpts {
	inventory: string;
	confirmDigest: string;
}

interface PrepareOptions extends CommonOpts {
	hold: string;
	inventory?: string;
	out: string;
}

interface ApplyOptions extends CommonOpts {
	plan: string;
	inventory?: string;
	confirmDigest: string;
}

interface ReceiptOptions extends CommonOpts {
	receipt: string;
	verify?: boolean;
}

interface ReleaseOptions extends CommonOpts {
	hold: string;
	confirm: string;
}
interface RollbackPrepareOptions extends CommonOpts {
	receipt: string;
	out: string;
}
interface RollbackApplyOptions extends CommonOpts {
	plan: string;
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

	withCommon(
		retirement
			.command('hold')
			.description('Acquire a durable dispatch drain for a reviewed inventory')
			.requiredOption('--inventory <file>', 'exact inventory JSON written by inventory')
			.requiredOption('--confirm-digest <digest>', 'confirm the reviewed inventory digest')
	).action(async (opts: HoldOptions) => {
		const inventoryJson = readFileSync(opts.inventory, 'utf8');
		const hold = await client(opts).acquireStateRetirementHold({
			inventory_json: inventoryJson,
			confirmation: { inventory_digest: opts.confirmDigest }
		});
		if (opts.json) return printJson(hold);
		console.log(`Hold: ${hold.id}`);
		console.log(
			`${hold.held_states.length} states held · ${hold.active_runs.length} active runs draining`
		);
	});

	withCommon(
		retirement
			.command('prepare')
			.description('Prepare a signed, reviewed preservation plan after the drain')
			.requiredOption('--hold <id>', 'durable state-retirement hold')
			.option('--inventory <file>', 'optional original inventory JSON used to acquire the hold')
			.requiredOption('--out <file>', 'write the plan JSON to this file')
	).action(async (opts: PrepareOptions) => {
		const plan = await client(opts).prepareStateRetirement({
			hold_id: opts.hold,
			...(opts.inventory ? { inventory_json: readFileSync(opts.inventory, 'utf8') } : {})
		});
		writeFileSync(opts.out, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' });
		if (opts.json) return printJson(plan);
		console.log(`Plan written to ${opts.out}`);
		console.log(`Digest: ${plan.plan_digest}`);
		console.log(
			plan.plan_token ? 'Signed apply token included' : 'Blocked: diagnostics require review'
		);
	});

	withCommon(
		retirement
			.command('apply')
			.description('Apply a signed plan once, or recover its durable receipt')
			.requiredOption('--plan <file>', 'signed plan JSON')
			.option('--inventory <file>', 'override the post-drain inventory embedded in the plan')
			.requiredOption('--confirm-digest <digest>', 'confirm the exact plan digest')
	).action(async (opts: ApplyOptions) => {
		const plan = JSON.parse(readFileSync(opts.plan, 'utf8')) as {
			plan_token?: string;
			inventory_json?: string;
		};
		if (!plan.plan_token)
			throw new Error('plan file has no apply token; blocked plans cannot be applied');
		const inventoryJson = opts.inventory
			? readFileSync(opts.inventory, 'utf8')
			: plan.inventory_json;
		if (!inventoryJson) throw new Error('plan file has no post-drain inventory; pass --inventory');
		const receipt = await client(opts).applyStateRetirement({
			plan_token: plan.plan_token,
			inventory_json: inventoryJson,
			confirmation: { plan_digest: opts.confirmDigest }
		});
		if (opts.json) return printJson(receipt);
		console.log(`Receipt: ${receipt.id}`);
		console.log('If the network failed, rerun the same plan and digest to recover this receipt.');
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

	withCommon(
		retirement
			.command('rollback-prepare <receipt>')
			.description('Prepare a separately signed conditional rollback')
			.requiredOption('--out <file>', 'write the rollback authorization')
	).action(async (receipt: string, opts: RollbackPrepareOptions) => {
		const value = await client(opts).prepareStateRetirementRollback({ receipt_id: receipt });
		writeFileSync(opts.out, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
		if (opts.json) return printJson(value);
		console.log(`Rollback authorization written to ${opts.out}`);
	});

	withCommon(
		retirement
			.command('rollback-apply')
			.description('Apply a signed conditional rollback once')
			.requiredOption('--plan <file>', 'rollback authorization JSON')
	).action(async (opts: RollbackApplyOptions) => {
		const plan = JSON.parse(readFileSync(opts.plan, 'utf8')) as {
			rollback_token: string;
			receipt_id: string;
			hold_id: string;
		};
		const value = await client(opts).applyStateRetirementRollback({
			rollback_token: plan.rollback_token,
			confirmation: { receipt_id: plan.receipt_id, hold_id: plan.hold_id }
		});
		if (opts.json) return printJson(value);
		console.log(`Rollback receipt: ${value.id}`);
	});
}
