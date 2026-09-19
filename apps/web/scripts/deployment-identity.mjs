import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const generatedIdentityPath = resolve(webRoot, '.generated/deployment.json');
const shaPattern = /^[0-9a-f]{40}$/;
const labelPattern = /^[A-Za-z0-9._+-]{1,128}$/;

function requireValue(value, name) {
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function validateIdentity(version, commit) {
	if (!labelPattern.test(version)) throw new Error('TINES_BUILD_VERSION is not a safe build label');
	if (!shaPattern.test(commit))
		throw new Error('TINES_BUILD_COMMIT must be a full lowercase Git SHA');
	return Object.freeze({ version, commit });
}

export function readGitHead() {
	return execFileSync('git', ['rev-parse', 'HEAD'], {
		cwd: resolve(webRoot, '../..'),
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore']
	}).trim();
}

export function resolveDeploymentIdentity(env = process.env, gitHead = readGitHead) {
	const channel = env.TINES_BUILD_CHANNEL;
	const suppliedVersion = env.TINES_BUILD_VERSION?.trim();
	const suppliedCommit = env.TINES_BUILD_COMMIT?.trim();

	if (channel === 'production' || channel === 'preview') {
		const version = requireValue(suppliedVersion, 'TINES_BUILD_VERSION');
		const commit = requireValue(suppliedCommit, 'TINES_BUILD_COMMIT');
		const identity = validateIdentity(version, commit);
		if (channel === 'production' && !/^\d+\.\d+\.\d+$/.test(version)) {
			throw new Error('Production TINES_BUILD_VERSION must be plain SemVer');
		}
		if (channel === 'preview' && !/^preview-pr-\d+-[0-9a-f]{12}$/.test(version)) {
			throw new Error('Preview TINES_BUILD_VERSION must identify its PR and commit');
		}
		const actual = gitHead();
		if (commit !== actual) throw new Error('TINES_BUILD_COMMIT does not match checked-out HEAD');
		return identity;
	}

	if (channel) throw new Error(`Unknown TINES_BUILD_CHANNEL '${channel}'`);
	if (suppliedVersion || suppliedCommit) {
		if (!suppliedVersion || !suppliedCommit) {
			throw new Error('TINES_BUILD_VERSION and TINES_BUILD_COMMIT must be supplied together');
		}
		return validateIdentity(suppliedVersion, suppliedCommit);
	}

	try {
		const commit = gitHead();
		return shaPattern.test(commit)
			? Object.freeze({ version: 'dev', commit })
			: Object.freeze({ version: 'dev', commit: 'unknown' });
	} catch {
		return Object.freeze({ version: 'dev', commit: 'unknown' });
	}
}

export function serializeDeploymentIdentity(identity) {
	return `${JSON.stringify(identity)}\n`;
}

export function deploymentIdentityPlugins(identity, outputPath = generatedIdentityPath) {
	return [
		{
			name: 'tines-deployment-identity-build',
			apply: 'build',
			buildStart() {
				mkdirSync(dirname(outputPath), { recursive: true });
				const temporaryPath = `${outputPath}.tmp`;
				writeFileSync(temporaryPath, serializeDeploymentIdentity(identity));
				renameSync(temporaryPath, outputPath);
			}
		},
		{
			name: 'tines-deployment-identity-dev',
			apply: 'serve',
			configureServer(server) {
				server.middlewares.use((request, response, next) => {
					const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
					if (pathname === '/api' || pathname.startsWith('/api/')) {
						response.setHeader('X-Tines-Version', identity.version);
						response.setHeader('X-Tines-Commit', identity.commit);
					}
					next();
				});
			}
		}
	];
}
