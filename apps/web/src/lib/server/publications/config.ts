import { PUBLIC_WORKFLOW_MAX_BYTES } from '@tines/shared';

export interface PublicationConfig {
	enabled: boolean;
	maxBytes: number;
	dailyQuota: number;
	valid: boolean;
	error: string | null;
	missingReadiness: string[];
}

export interface HostModerationConfig {
	valid: boolean;
	moderatorUserIds: ReadonlySet<string>;
	reportHourlyQuota: number;
	hmacSecret: string | null;
	appealContact: string | null;
	queueReady: boolean;
	journeyVerified: boolean;
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
	const host = hostModerationConfig(env);
	const missingReadiness = [
		...(host.moderatorUserIds.size ? [] : ['Assign a host reviewer']),
		...(host.appealContact ? [] : ['Configure appeals']),
		...(host.queueReady ? [] : ['Establish daily review']),
		...(host.journeyVerified ? [] : ['Verify moderation'])
	];
	const valid = enabledValid && maxBytes !== null && dailyQuota !== null && host.valid;
	return {
		enabled: valid && missingReadiness.length === 0 && enabledValue === 'true',
		maxBytes: maxBytes ?? PUBLIC_WORKFLOW_MAX_BYTES,
		dailyQuota: dailyQuota ?? 10,
		valid,
		error: valid
			? missingReadiness.length
				? 'Public workflow publishing is awaiting host readiness'
				: null
			: 'Invalid public workflow publication configuration; creation is disabled',
		missingReadiness
	};
}

function parseModeratorIds(value: string | undefined): string[] | null {
	if (!value) return [];
	const ids = value.split(',').map((id) => id.trim());
	if (
		ids.length > 20 ||
		ids.some((id) => !/^[A-Za-z0-9_-]{1,128}$/u.test(id)) ||
		new Set(ids).size !== ids.length
	)
		return null;
	return ids;
}

function parseHmacSecret(value: string | undefined): string | null {
	if (!value) return null;
	try {
		const decoded = atob(value);
		return decoded.length >= 32 ? value : null;
	} catch {
		return null;
	}
}

function parseAppealContact(value: string | undefined): string | null {
	if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
	try {
		const url = new URL(value);
		if (url.hash || url.username || url.password) return null;
		if (url.protocol === 'https:') return url.toString();
		if (url.protocol === 'mailto:' && !url.search && /^mailto:[^?\s@]+@[^?\s@]+$/u.test(value))
			return value;
	} catch {
		return null;
	}
	return null;
}

export function hostModerationConfig(env: Env): HostModerationConfig {
	const ids = parseModeratorIds(env.PUBLIC_WORKFLOW_MODERATOR_USER_IDS);
	const quota = boundedInteger(env.PUBLIC_WORKFLOW_REPORT_HOURLY_QUOTA, 5, 1000);
	const hmacSecret = parseHmacSecret(env.PUBLIC_WORKFLOW_REPORT_HMAC_SECRET);
	const appealContact = parseAppealContact(env.PUBLIC_WORKFLOW_APPEAL_CONTACT);
	const queueReady = env.PUBLIC_WORKFLOW_MODERATION_QUEUE_READY === 'true';
	const journeyVerified = env.PUBLIC_WORKFLOW_MODERATION_JOURNEY_VERIFIED === 'true';
	const booleansValid = [
		env.PUBLIC_WORKFLOW_MODERATION_QUEUE_READY,
		env.PUBLIC_WORKFLOW_MODERATION_JOURNEY_VERIFIED
	].every((value) => value === undefined || value === '' || value === 'true' || value === 'false');
	const valid = ids !== null && quota !== null && hmacSecret !== null && booleansValid;
	return {
		valid,
		moderatorUserIds: new Set(ids ?? []),
		reportHourlyQuota: quota ?? 5,
		hmacSecret,
		appealContact,
		queueReady,
		journeyVerified,
		error: valid ? null : 'Public workflow moderation is not configured'
	};
}
