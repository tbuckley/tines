import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
	deploymentIdentityPlugins,
	resolveDeploymentIdentity,
	serializeDeploymentIdentity
} from '../../../scripts/deployment-identity.mjs';

const sha = '0123456789abcdef0123456789abcdef01234567';

describe('deployment identity build inputs', () => {
	it('defaults to an honest development identity', () => {
		expect(resolveDeploymentIdentity({}, () => sha)).toEqual({ version: 'dev', commit: sha });
		expect(
			resolveDeploymentIdentity({}, () => {
				throw new Error('archive');
			})
		).toEqual({
			version: 'dev',
			commit: 'unknown'
		});
	});

	it('accepts complete local overrides and rejects partial or unsafe values', () => {
		expect(
			resolveDeploymentIdentity({ TINES_BUILD_VERSION: 'package-1', TINES_BUILD_COMMIT: sha })
		).toEqual({ version: 'package-1', commit: sha });
		expect(() => resolveDeploymentIdentity({ TINES_BUILD_VERSION: 'only' })).toThrow(/together/);
		expect(() =>
			resolveDeploymentIdentity({
				TINES_BUILD_VERSION: 'bad\nheader',
				TINES_BUILD_COMMIT: sha
			})
		).toThrow(/safe build label/);
	});

	it('strictly validates production and preview identities against HEAD', () => {
		expect(
			resolveDeploymentIdentity(
				{
					TINES_BUILD_CHANNEL: 'production',
					TINES_BUILD_VERSION: '0.0.1234',
					TINES_BUILD_COMMIT: sha
				},
				() => sha
			)
		).toEqual({ version: '0.0.1234', commit: sha });
		expect(
			resolveDeploymentIdentity(
				{
					TINES_BUILD_CHANNEL: 'preview',
					TINES_BUILD_VERSION: 'preview-pr-598-0123456789ab',
					TINES_BUILD_COMMIT: sha
				},
				() => sha
			)
		).toEqual({ version: 'preview-pr-598-0123456789ab', commit: sha });
		expect(() =>
			resolveDeploymentIdentity({ TINES_BUILD_CHANNEL: 'production' }, () => sha)
		).toThrow(/required/);
		expect(() =>
			resolveDeploymentIdentity(
				{
					TINES_BUILD_CHANNEL: 'preview',
					TINES_BUILD_VERSION: 'preview',
					TINES_BUILD_COMMIT: sha
				},
				() => sha
			)
		).toThrow(/identify its PR/);
		expect(() =>
			resolveDeploymentIdentity(
				{
					TINES_BUILD_CHANNEL: 'production',
					TINES_BUILD_VERSION: '0.0.1',
					TINES_BUILD_COMMIT: sha
				},
				() => 'f'.repeat(40)
			)
		).toThrow(/does not match/);
	});

	it('writes the same serialized object only from the build plugin', () => {
		const output = join(mkdtempSync(join(tmpdir(), 'tines-deployment-')), 'deployment.json');
		const plugins = deploymentIdentityPlugins({ version: 'dev', commit: sha }, output);
		expect(existsSync(output)).toBe(false);
		const build = plugins.find((plugin) => plugin.name.endsWith('-build'))!;
		expect(build.apply).toBe('build');
		(build.buildStart as () => void)();
		expect(readFileSync(output, 'utf8')).toBe(
			serializeDeploymentIdentity({ version: 'dev', commit: sha })
		);
	});

	it('adds development headers to exact API paths only', () => {
		const plugin = deploymentIdentityPlugins({ version: 'dev', commit: sha }).find((candidate) =>
			candidate.name.endsWith('-dev')
		)!;
		let middleware: (
			req: { url: string },
			res: { setHeader: ReturnType<typeof vi.fn> },
			next: () => void
		) => void;
		(plugin.configureServer as (server: unknown) => void)({
			middlewares: {
				use: (value: typeof middleware) => {
					middleware = value;
				}
			}
		});
		const setHeader = vi.fn();
		const next = vi.fn();
		middleware!({ url: '/api/time?x=1' }, { setHeader }, next);
		expect(setHeader).toHaveBeenCalledWith('X-Tines-Version', 'dev');
		expect(setHeader).toHaveBeenCalledWith('X-Tines-Commit', sha);
		setHeader.mockClear();
		middleware!({ url: '/apiary' }, { setHeader }, next);
		expect(setHeader).not.toHaveBeenCalled();
	});
});
