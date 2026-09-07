/**
 * Artifact "sites": HTML artifacts rendered live (scripts running) in a
 * sandboxed frame or as a full page — see specs/artifacts/SPEC.md
 * "Sites: HTML artifacts".
 *
 * Pure helpers only, so the same rules answer "is this a site?" on the
 * server (minting a link), in the viewer, and in the CLI.
 */

/** How long a minted site link stays valid. Links are snapshots, not shares. */
export const ARTIFACT_SITE_LINK_TTL_MS = 60 * 60 * 1000;

/** Entry document of a folder site: the only path we will serve `/s/<token>/` from. */
export const ARTIFACT_SITE_INDEX = 'index.html';

/**
 * The path a site's `/s/<token>/` serves, or null when the artifact is not a
 * site. `file`/`text` sites are the file itself; a `folder` is a site when its
 * version has a root `index.html`, so relative URLs to siblings resolve.
 */
export function siteEntry(
	type: string,
	contentType: string | null,
	files: { path: string }[] = []
): string | null {
	if (type === 'file' || type === 'text') {
		return (contentType ?? '').toLowerCase().startsWith('text/html') ? '' : null;
	}
	if (type === 'folder') {
		return files.some((f) => f.path === ARTIFACT_SITE_INDEX) ? ARTIFACT_SITE_INDEX : null;
	}
	return null;
}

const VIEWPORT_META =
	/<meta[^>]+name\s*=\s*["']?viewport["']?[^>]*content\s*=\s*["'][^"']*width\s*=\s*device-width/i;
const EXTERNAL_URL = /^(?:https?:)?\/\//i;

function externalRefs(html: string): string[] {
	const found: string[] = [];
	const push = (url: string | undefined) => {
		if (url && EXTERNAL_URL.test(url.trim()) && !found.includes(url.trim())) found.push(url.trim());
	};
	for (const m of html.matchAll(/<script[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi)) push(m[1]);
	for (const m of html.matchAll(/<link[^>]*\shref\s*=\s*["']([^"']+)["']/gi)) push(m[1]);
	for (const m of html.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']/gi)) push(m[1]);
	return found;
}

/**
 * Warnings (never errors) for an HTML artifact, shown at attach time by the
 * CLI and the web attach dialog: the two things that make a prototype look
 * broken on a phone or blank under the site CSP.
 */
export function lintHtmlArtifact(html: string): string[] {
	const warnings: string[] = [];
	if (!VIEWPORT_META.test(html)) {
		warnings.push(
			'no viewport meta tag — add <meta name="viewport" content="width=device-width, initial-scale=1"> so it lays out for phones'
		);
	}
	const external = externalRefs(html);
	if (external.length > 0) {
		warnings.push(
			`external scripts/styles are blocked by the sandbox policy (${external.slice(0, 3).join(', ')}${external.length > 3 ? ', …' : ''}) — inline or vendor them into the artifact`
		);
	}
	return warnings;
}
