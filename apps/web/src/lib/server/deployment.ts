import type { VersionResponse } from '@tines/shared';

export const deploymentIdentity: Readonly<VersionResponse> = Object.freeze({
	version: __TINES_DEPLOYMENT__.version,
	commit: __TINES_DEPLOYMENT__.commit
});
