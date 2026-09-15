export const PUBLICATION_REPORT_REASONS = [
	'harmful_abusive',
	'malicious_phishing',
	'private_information',
	'rights',
	'other'
] as const;

export type PublicationReportReason = (typeof PUBLICATION_REPORT_REASONS)[number];

export interface PublicationReportRequest {
	request_id: string;
	reason: PublicationReportReason;
	note?: string;
}

export interface PublicationReportReceipt {
	receipt: { reference: string; received_at: number };
	retry_until: number;
}

export type ModerationAction = 'dismiss' | 'disable' | 'restore' | 'suspend' | 'unsuspend';

export interface ModerationDecisionRequest {
	request_id: string;
	action: ModerationAction;
	target: { snapshot_id?: string; publisher_id?: string };
	reason: string;
	expected_snapshot_version?: number;
	expected_publisher_version?: number;
	case_through_version?: number;
}

export interface WorkflowReportCase {
	snapshot_id: string;
	display_name: string;
	title: string;
	version: number;
	read_through_version: number;
	resolved_through_version: number;
	latest_report_at: number;
	total: number;
	reason_counts: Partial<Record<PublicationReportReason, number>>;
	host_state: 'active' | 'removed' | null;
	owner_state: 'published' | 'withdrawn' | null;
	status_version: number | null;
	suspended: boolean;
	publisher_status_version: number;
}

export interface ModerationDecisionReceipt {
	decision_id: string;
	action: ModerationAction;
	target: { kind: 'snapshot' | 'publisher'; id: string };
	decided_at: number;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DISALLOWED_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|[\ud800-\udfff]/u;

export function normalizeModerationText(value: string): string {
	return value.replace(/\r\n?/g, '\n');
}

export function moderationTextLength(value: string): number {
	return [...value].length;
}

export function validateModerationText(value: unknown, required: boolean): string {
	if (typeof value !== 'string') throw new Error('must be a string');
	const normalized = normalizeModerationText(value);
	if (required && normalized.trim().length === 0) throw new Error('must not be blank');
	if (
		DISALLOWED_TEXT.test(normalized) ||
		moderationTextLength(normalized) > 1000 ||
		new TextEncoder().encode(normalized).byteLength > 4000
	)
		throw new Error('must be at most 1,000 characters and contain plain text');
	return normalized;
}

export function validateRequestId(value: unknown): string {
	if (typeof value !== 'string' || !UUID_V4.test(value)) throw new Error('must be a random UUIDv4');
	return value;
}

export function validatePublicationReportRequest(
	value: unknown
): Required<PublicationReportRequest> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('invalid request');
	const input = value as Record<string, unknown>;
	if (Object.keys(input).some((key) => !['request_id', 'reason', 'note'].includes(key)))
		throw new Error('unknown field');
	if (!PUBLICATION_REPORT_REASONS.includes(input.reason as PublicationReportReason))
		throw new Error('reason is required');
	return {
		request_id: validateRequestId(input.request_id),
		reason: input.reason as PublicationReportReason,
		note: validateModerationText(input.note ?? '', false)
	};
}
