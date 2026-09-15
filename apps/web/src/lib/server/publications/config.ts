import { PUBLIC_WORKFLOW_MAX_BYTES } from '@tines/shared';

export interface PublicationConfig {
	enabled: boolean;
	maxBytes: number;
	dailyQuota: number;
	valid: boolean;
	error: string | null;
}

function boundedInteger(
	value: string | undefined,
	fallback: number,
	maximum: number
): number | null {
	if (value === undefined || value === '') return fallback;
	if (!/^[1-9]\d*$/u.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

export function publicationConfig(env: Env): PublicationConfig {
	const maxBytes = boundedInteger(
		env.PUBLIC_WORKFLOW_MAX_BYTES,
		PUBLIC_WORKFLOW_MAX_BYTES,
		PUBLIC_WORKFLOW_MAX_BYTES
	);
	const dailyQuota = boundedInteger(env.PUBLIC_WORKFLOW_DAILY_QUOTA, 10, 1000);
	const enabledValue = env.PUBLIC_WORKFLOW_PUBLISHING_ENABLED;
	const enabledValid =
		enabledValue === undefined ||
		enabledValue === '' ||
		enabledValue === 'true' ||
		enabledValue === 'false';
	const valid = enabledValid && maxBytes !== null && dailyQuota !== null;
	return {
		enabled: valid && enabledValue === 'true',
		maxBytes: maxBytes ?? PUBLIC_WORKFLOW_MAX_BYTES,
		dailyQuota: dailyQuota ?? 10,
		valid,
		error: valid ? null : 'Invalid public workflow publication configuration; creation is disabled'
	};
}
