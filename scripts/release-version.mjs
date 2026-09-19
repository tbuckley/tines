#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function calculateReleaseVersion(manifestVersion, commitCount) {
	if (!/^\d+\.\d+\.\d+$/.test(manifestVersion)) {
		throw new Error(`CLI manifest version '${manifestVersion}' is not plain major.minor.patch`);
	}
	if (!Number.isSafeInteger(commitCount) || commitCount < 1) {
		throw new Error(`Git commit count '${commitCount}' is not a positive integer`);
	}
	return `${manifestVersion.split('.').slice(0, 2).join('.')}.${commitCount}`;
}

export function releaseVersion(options = {}) {
	const root = options.repositoryRoot ?? repositoryRoot;
	const git =
		options.git ?? ((args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim());
	if (git(['rev-parse', '--is-shallow-repository']) === 'true') {
		throw new Error('Release version requires a non-shallow Git checkout');
	}
	git(['rev-parse', '--verify', 'HEAD']);
	const manifest = JSON.parse(
		readFileSync(resolve(root, 'packages/cli/package.json'), { encoding: 'utf8' })
	);
	return calculateReleaseVersion(manifest.version, Number(git(['rev-list', '--count', 'HEAD'])));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		process.stdout.write(`${releaseVersion()}\n`);
	} catch (error) {
		process.stderr.write(
			`release-version: ${error instanceof Error ? error.message : String(error)}\n`
		);
		process.exitCode = 1;
	}
}
