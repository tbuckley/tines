import { createApiClient } from '@tines/shared';
import { Command } from 'commander';

const DEFAULT_URL = process.env.TINES_API_URL ?? 'http://localhost:5173';

const program = new Command();

program.name('tines').description('CLI for Tines').version('0.0.1');

program
	.command('time')
	.description('Fetch the current time from the Tines API')
	.option('-u, --url <url>', 'base URL of the Tines API (or set TINES_API_URL)', DEFAULT_URL)
	.option('--json', 'output the raw JSON response')
	.action(async (opts: { url: string; json?: boolean }) => {
		const api = createApiClient({ baseUrl: opts.url });
		try {
			const result = await api.getTime();
			if (opts.json) {
				console.log(JSON.stringify(result, null, 2));
			} else {
				console.log(`Server time: ${result.time} (unix ${result.unix})`);
			}
		} catch (err) {
			console.error(
				`Failed to fetch time from ${opts.url}: ${err instanceof Error ? err.message : err}`
			);
			process.exitCode = 1;
		}
	});

await program.parseAsync();
