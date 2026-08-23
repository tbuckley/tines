/**
 * Seeds the local e2e D1 database with two users, one session each, and one
 * API key each. Run after migrations, before `wrangler dev` (see server.sh).
 *
 * Better Auth reads sessions from its own tables; inserting a user + session
 * row directly (dates as ISO strings, which its sqlite adapter parses) plus
 * a signed cookie in the tests is enough to act as a signed-in browser.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALICE, BOB } from './constants.mjs';

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');

const nowIso = new Date().toISOString();
const nowMs = Date.now();
const expires = '2030-01-01T00:00:00.000Z';

const statements = [];
for (const user of [ALICE, BOB]) {
	statements.push(
		`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
		 VALUES ('${user.id}', '${user.name}', '${user.email}', 1, '${nowIso}', '${nowIso}');`,
		`INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId)
		 VALUES ('ses_${user.id}', '${expires}', '${user.sessionToken}', '${nowIso}', '${nowIso}', '${user.id}');`,
		`INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, created_at)
		 VALUES ('key_${user.id}', '${user.id}', '${user.apiKeyName}', '${sha256Hex(user.apiKey)}', '${user.apiKey.slice(0, 14)}', ${nowMs});`
	);
}

const sqlFile = join(mkdtempSync(join(tmpdir(), 'tines-e2e-')), 'seed.sql');
writeFileSync(sqlFile, statements.join('\n'));

execFileSync(
	'pnpm',
	['exec', 'wrangler', 'd1', 'execute', 'tines', '--local', '--persist-to', '.wrangler-e2e', '--file', sqlFile],
	{ stdio: 'inherit' }
);
console.log('e2e seed complete');
