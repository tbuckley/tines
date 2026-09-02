/**
 * Seeds the local dev database (`pnpm dev` / `pnpm preview`) with one user
 * and one API key, so a fresh clone can use the CLI and sign in straight
 * away. Idempotent: rerunning is a no-op. Run after `pnpm db:migrate:local`.
 *
 * Sign-in needs no seeding of its own — enter the seeded address on the
 * landing page and `pnpm dev` prints the magic link to its console — but
 * the API key does: the web app only ever shows a key once, at creation.
 *
 * The key is a fixed, obviously-fake value so it can be pasted from the
 * README. It only ever unlocks the local database.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEV_USER = {
	id: 'usr_dev',
	name: 'Dev',
	email: 'dev@tines.local',
	// `tines_` + 40 characters, the shape createApiKey() generates.
	apiKey: 'tines_dev0000000000000000000000000000000000000',
	apiKeyName: 'dev-seed'
};

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');
const nowIso = new Date().toISOString();
const nowMs = Date.now();

const statements = [
	`INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt)
	 VALUES ('${DEV_USER.id}', '${DEV_USER.name}', '${DEV_USER.email}', 1, '${nowIso}', '${nowIso}');`,
	`INSERT OR IGNORE INTO api_key (id, user_id, name, key_hash, key_prefix, created_at)
	 VALUES ('key_${DEV_USER.id}', '${DEV_USER.id}', '${DEV_USER.apiKeyName}',
	   '${sha256Hex(DEV_USER.apiKey)}', '${DEV_USER.apiKey.slice(0, 14)}', ${nowMs});`
];

const sqlFile = join(mkdtempSync(join(tmpdir(), 'tines-seed-')), 'seed.sql');
writeFileSync(sqlFile, statements.join('\n'));

// Same local D1 state `pnpm dev` and `wrangler dev` use (.wrangler/state).
execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'tines', '--local', '--file', sqlFile], {
	stdio: ['ignore', 'ignore', 'inherit']
});

console.log(`seeded user ${DEV_USER.email} with API key ${DEV_USER.apiKeyName}

  # for the CLI (or: tines login --url http://localhost:5173 --api-key ${DEV_USER.apiKey})
  export TINES_API_KEY=${DEV_USER.apiKey}

  # for the browser: enter ${DEV_USER.email} on http://localhost:5173 and open the
  # magic link \`pnpm dev\` prints to its console`);
