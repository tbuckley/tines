import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateReleaseVersion, releaseVersion } from './release-version.mjs';

test('uses manifest major/minor and Git history, ignoring manifest patch', () => {
	assert.equal(calculateReleaseVersion('2.7.999', 1234), '2.7.1234');
});

test('rejects invalid manifests and counts', () => {
	assert.throws(() => calculateReleaseVersion('2.7.x', 12), /plain major\.minor\.patch/);
	assert.throws(() => calculateReleaseVersion('2.7.0', 0), /positive integer/);
});

test('rejects shallow and missing Git repositories', () => {
	assert.throws(() => releaseVersion({ git: () => 'true' }), /non-shallow Git checkout/);
	assert.throws(
		() =>
			releaseVersion({
				git: () => {
					throw new Error('not a repository');
				}
			}),
		/not a repository/
	);
});
