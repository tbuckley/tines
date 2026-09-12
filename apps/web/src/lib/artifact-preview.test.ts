import type { Artifact, ArtifactVersion } from '@tines/shared';
import { describe, expect, test } from 'vitest';
import {
	artifactPreviewKey,
	artifactPreviewUrl,
	resolveArtifactPreview,
	type ResolvedArtifactPreview
} from './artifact-preview';

const version = (number: number): ArtifactVersion =>
	({
		version: number,
		filename: 'report.md',
		content_type: 'text/markdown',
		size_bytes: 10,
		file_count: null,
		url: null,
		title: null,
		pr_repo_url: null,
		pr_number: null,
		reaffirmed_from: null,
		actor: { user_id: 'user-1', user_name: 'Alice', api_key_id: null, api_key_name: null },
		created_at: 1
	}) satisfies ArtifactVersion;

function artifact(id: string, issueId: string, name = 'report', current = version(1)): Artifact {
	return {
		id,
		issue_id: issueId,
		name,
		artifact_type: 'text',
		description: '',
		version_count: current.version,
		current_version: current,
		fresh: true,
		created_at: 1,
		updated_at: 1
	};
}

describe('resolved artifact previews', () => {
	test('distinguish issues and replacements with the same name and version', () => {
		const issueA = resolveArtifactPreview(artifact('artifact-a', 'issue-a'), version(1));
		const issueB = resolveArtifactPreview(artifact('artifact-b', 'issue-b'), version(1));
		const replacement = resolveArtifactPreview(
			artifact('artifact-replacement', 'issue-a'),
			version(1)
		);

		expect(
			new Set([
				artifactPreviewKey(issueA),
				artifactPreviewKey(issueB),
				artifactPreviewKey(replacement)
			]).size
		).toBe(3);
		expect(artifactPreviewUrl(issueA)).toContain('/issues/issue-a/artifacts/report/content?');
		expect(artifactPreviewUrl(issueB)).toContain('/issues/issue-b/artifacts/report/content?');
	});

	test('distinguishes versions, paths, delimiters, and a missing path from an empty path', () => {
		const preview = resolveArtifactPreview(artifact('artifact|@/[]', 'issue-a'), version(1));
		const versionTwo = resolveArtifactPreview(artifact('artifact|@/[]', 'issue-a'), version(2));
		const keys = [
			artifactPreviewKey(preview),
			artifactPreviewKey(preview, ''),
			artifactPreviewKey(preview, 'a/b'),
			artifactPreviewKey(preview, 'a|b@1/[x]'),
			artifactPreviewKey(versionTwo, 'a/b')
		];

		expect(new Set(keys).size).toBe(keys.length);
	});

	test('pins and encodes every content URL', () => {
		const historical = resolveArtifactPreview(
			artifact('artifact-a', 'issue /?#%', 'report /?#%', version(9)),
			version(4)
		);
		const path = 'nested/a & b?#%/日本語.md';
		const download = artifactPreviewUrl(historical, { path });
		const inline = artifactPreviewUrl(historical, { path, inline: true });

		for (const value of [download, inline]) {
			const url = new URL(value, 'https://example.test');
			expect(url.pathname).toBe(
				'/api/v1/issues/issue%20%2F%3F%23%25/artifacts/report%20%2F%3F%23%25/content'
			);
			expect(url.searchParams.get('version')).toBe('4');
			expect(url.searchParams.get('path')).toBe(path);
		}
		expect(new URL(download, 'https://example.test').searchParams.has('inline')).toBe(false);
		expect(new URL(inline, 'https://example.test').searchParams.get('inline')).toBe('1');
	});

	test('requires a concrete version at compile time', () => {
		// @ts-expect-error A resolved preview cannot represent unpinned current content.
		const unresolved: ResolvedArtifactPreview = { issueId: 'i', artifactId: 'a', name: 'n' };
		expect(unresolved).toBeDefined();
	});
});
