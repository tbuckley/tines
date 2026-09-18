/**
 * Helpers for the inert package proof. Declared tokens are located in the exact
 * source text with the shared escape rule (a token directly preceded by `\` is a
 * literal, not a substitutable use) before any Markdown rendering, so the proof
 * decorates exactly the occurrences that installation will replace.
 */

export type DeclaredToken = { token: string; inputId: string };
export type TokenOccurrence = { start: number; end: number; token: string; inputId: string };

const MARK_START = '';
const MARK_END = '';
const MARK_PATTERN = new RegExp(`${MARK_START}(\\d+)${MARK_END}`, 'g');

/** Every unescaped occurrence of every declared token, in source order. */
export function declaredOccurrences(text: string, tokens: readonly DeclaredToken[]) {
	const matches: TokenOccurrence[] = [];
	for (const item of tokens) {
		if (!item.token) continue;
		let from = 0;
		while (from < text.length) {
			const start = text.indexOf(item.token, from);
			if (start < 0) break;
			if (start === 0 || text[start - 1] !== '\\')
				matches.push({ start, end: start + item.token.length, ...item });
			from = start + item.token.length;
		}
	}
	matches.sort((a, b) => a.start - b.start);
	const result: TokenOccurrence[] = [];
	let at = 0;
	for (const match of matches) {
		if (match.start < at) continue;
		result.push(match);
		at = match.end;
	}
	return result;
}

/**
 * Replaces each substitutable occurrence with a private-use marker naming its
 * index, so the token's own characters never pass through the Markdown parser
 * and escaped literals render as ordinary text.
 */
export function markDeclaredOccurrences(text: string, tokens: readonly DeclaredToken[]) {
	const occurrences = declaredOccurrences(text, tokens);
	let source = '';
	let at = 0;
	occurrences.forEach((occurrence, index) => {
		source += text.slice(at, occurrence.start) + MARK_START + index + MARK_END;
		at = occurrence.end;
	});
	source += text.slice(at);
	return { source, occurrences };
}

/** Splits rendered text into literal runs and marker indexes. */
export function splitMarkers(value: string): Array<{ text: string } | { index: number }> {
	const pieces: Array<{ text: string } | { index: number }> = [];
	let at = 0;
	for (const match of value.matchAll(MARK_PATTERN)) {
		if (match.index > at) pieces.push({ text: value.slice(at, match.index) });
		pieces.push({ index: Number(match[1]) });
		at = match.index + match[0].length;
	}
	if (at < value.length) pieces.push({ text: value.slice(at) });
	return pieces;
}

/**
 * Turns every rendered `<img>` into an inert placeholder that names the source
 * and alternative text without requesting the resource.
 */
export function inertMarkdownImages(html: string): string {
	return html.replace(/<img\b([^>]*?)\/?>/gi, (_, attributes: string) => {
		const src = attribute(attributes, 'src');
		const alt = attribute(attributes, 'alt');
		const label = alt ? `${alt} — ${src}` : src;
		return `<span class="markdown-inert-image" role="img" aria-label="Image not loaded: ${label}">Image (not loaded): ${label}</span>`;
	});
}

function attribute(attributes: string, name: string) {
	// Attribute values were HTML-encoded by the renderer, so they are safe to re-embed.
	return new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(attributes)?.[1] ?? '';
}
