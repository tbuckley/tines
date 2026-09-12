import type { Artifact, ArtifactVersion } from '@tines/shared';

/** One immutable artifact snapshot selected by the preview UI. */
export type ResolvedArtifactPreview = Readonly<{
	issueId: string;
	artifactId: string;
	name: string;
	version: number;
}>;

export function resolveArtifactPreview(
	artifact: Artifact,
	version: ArtifactVersion
): ResolvedArtifactPreview {
	return {
		issueId: artifact.issue_id,
		artifactId: artifact.id,
		name: artifact.name,
		version: version.version
	};
}

export function artifactPreviewKey(preview: ResolvedArtifactPreview, path?: string): string {
	return JSON.stringify([preview.artifactId, preview.version, path ?? null]);
}

export function artifactPreviewUrl(
	preview: ResolvedArtifactPreview,
	options: { path?: string; inline?: boolean } = {}
): string {
	const params = new URLSearchParams({ version: String(preview.version) });
	if (options.path !== undefined) params.set('path', options.path);
	if (options.inline) params.set('inline', '1');
	return `/api/v1/issues/${encodeURIComponent(preview.issueId)}/artifacts/${encodeURIComponent(preview.name)}/content?${params.toString()}`;
}
