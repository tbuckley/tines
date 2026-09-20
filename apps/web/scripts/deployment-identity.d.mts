import type { Plugin } from 'vite';

export interface DeploymentIdentity {
	readonly version: string;
	readonly commit: string;
}

export const generatedIdentityPath: string;
export function readGitHead(): string;
export function resolveDeploymentIdentity(
	env?: NodeJS.ProcessEnv,
	gitHead?: () => string
): DeploymentIdentity;
export function serializeDeploymentIdentity(identity: DeploymentIdentity): string;
export function deploymentIdentityPlugins(
	identity: DeploymentIdentity,
	outputPath?: string
): Plugin[];
