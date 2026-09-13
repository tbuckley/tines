import { canonicalizeLibraryValue } from './library/canonical.js';
import type { ExportWorkflowPackageOptions, WorkflowPackageDocument } from './library/types.js';

export const PUBLIC_WORKFLOW_POLICY_VERSION = 1 as const;
export const PUBLIC_WORKFLOW_MAX_BYTES = 1_048_576;
export const PUBLICATION_CANDIDATE_TTL_MS = 15 * 60 * 1000;

export interface PublicationMetadata {
	display_name: string;
	license: 'MIT';
	license_year: number;
}

export type PublicationSource =
	| {
			kind: 'owned_workflow';
			workflow_id: string;
			options: ExportWorkflowPackageOptions;
	  }
	| { kind: 'file'; document_json: string };

export interface PublicationDiagnostic {
	path: string;
	record_id?: string;
	file_id?: string;
	code: string;
	message: string;
	required: boolean;
	actions: Array<'repair_source' | 'replace_file' | 'exclude_optional'>;
}

export interface PublicationHashes {
	document_digest: string;
	bytes_sha256: string;
	review_digest: string;
}

export interface PublicationProof extends PublicationHashes {
	candidate_id: string;
	expires_at: number;
	byte_length: number;
	metadata: PublicationMetadata;
	document: WorkflowPackageDocument;
}

export interface PublicationReceipt extends PublicationHashes {
	snapshot_id: string;
	public_url: string;
	published_at: number;
	status_version: number;
}

export interface PublicWorkflowSnapshot extends PublicationHashes {
	snapshot_id: string;
	metadata: PublicationMetadata;
	published_at: number;
	status_version: number;
	document: WorkflowPackageDocument;
}

export function validatePublicationMetadata(value: PublicationMetadata): PublicationMetadata {
	const displayName = value.display_name.trim();
	if (
		displayName.length < 1 ||
		displayName.length > 100 ||
		/[\u0000-\u001f\u007f]/u.test(displayName) ||
		/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(displayName)
	)
		throw new Error(
			'Display name must be 1–100 characters, contain no controls, and not be an email'
		);
	if (value.license !== 'MIT') throw new Error('Only the MIT license is supported');
	if (
		!Number.isSafeInteger(value.license_year) ||
		value.license_year < 1970 ||
		value.license_year > 9999
	)
		throw new Error('Invalid license year');
	return { display_name: displayName, license: 'MIT', license_year: value.license_year };
}

export function publicationReuseNotice(metadata: PublicationMetadata): string {
	const valid = validatePublicationMetadata(metadata);
	return `MIT License\n\nCopyright (c) ${valid.license_year} ${valid.display_name}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function publicationBytesSha256(canonicalDocumentJson: string): Promise<string> {
	return sha256(canonicalDocumentJson);
}

export async function publicationReviewDigest(input: {
	candidate_id: string;
	bytes_sha256: string;
	metadata: PublicationMetadata;
	source_witness_sha256: string;
	selection: unknown;
	policy_version?: number;
}): Promise<string> {
	return sha256(
		`TINES-PUBLICATION-REVIEW\u0000${canonicalizeLibraryValue({
			candidate_id: input.candidate_id,
			bytes_sha256: input.bytes_sha256,
			metadata: validatePublicationMetadata(input.metadata),
			policy_version: input.policy_version ?? PUBLIC_WORKFLOW_POLICY_VERSION,
			selection: input.selection,
			source_witness_sha256: input.source_witness_sha256
		})}`
	);
}

const SNAPSHOT_ID = /^[A-Za-z0-9_-]{20,100}$/;

export function parsePublicSnapshotReference(value: string, configuredOrigin?: string): string {
	if (SNAPSHOT_ID.test(value)) return value;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error('Expected a publication ID or canonical public URL');
	}
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
		throw new Error('Invalid public publication URL');
	if (configuredOrigin && url.origin !== new URL(configuredOrigin).origin)
		throw new Error('external_source_requires_download');
	const match = /^\/p\/([A-Za-z0-9_-]{20,100})(?:\/download)?$/.exec(url.pathname);
	if (!match || url.search) throw new Error('Invalid public publication URL');
	return match[1];
}
