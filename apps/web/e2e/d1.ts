import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WEB_DIR = fileURLToPath(new URL('..', import.meta.url));
const LOCK_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function diagnosticText(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (value instanceof Uint8Array) return new TextDecoder().decode(value);
}

function isDatabaseLock(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const { stdout, stderr } = error as { stdout?: unknown; stderr?: unknown };
	return [stderr, stdout].some((diagnostic) => {
		const text = diagnosticText(diagnostic);
		return (
			text !== undefined &&
			(/\bSQLITE_BUSY(?:_[A-Z0-9]+)*\b/.test(text) || /database is locked/i.test(text))
		);
	});
}

function execute(sql: string): string {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return execFileSync(
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
		} catch (error) {
			const delay = LOCK_RETRY_DELAYS_MS[attempt];
			if (delay === undefined || !isDatabaseLock(error)) throw error;
			Atomics.wait(LOCK_WAIT, 0, 0, delay);
		}
	}
}

export const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function d1<T extends Record<string, unknown>>(sql: string): T[] {
	const raw = execute(sql);
	const statements = JSON.parse(raw) as { success: boolean; results: T[] }[];
	if (statements.some((statement) => !statement.success)) throw new Error(raw);
	return statements.flatMap((statement) => statement.results ?? []);
}
