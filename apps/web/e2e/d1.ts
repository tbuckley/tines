import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WEB_DIR = fileURLToPath(new URL('..', import.meta.url));

export const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function d1<T extends Record<string, unknown>>(sql: string): T[] {
	const raw = execFileSync(
		'pnpm',
		[
			'exec',
			'wrangler',
			'd1',
			'execute',
			'tines',
			'--local',
			'--persist-to',
			'.wrangler-e2e',
			'--json',
			'--command',
			sql
		],
		{ cwd: WEB_DIR, encoding: 'utf8' }
	);
	const statements = JSON.parse(raw) as { success: boolean; results: T[] }[];
	if (statements.some((statement) => !statement.success)) throw new Error(raw);
	return statements.flatMap((statement) => statement.results ?? []);
}
