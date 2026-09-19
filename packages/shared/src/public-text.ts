import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

export interface PublicTextSpan {
	text: string;
	strong?: boolean;
	emphasis?: boolean;
	deleted?: boolean;
	code?: boolean;
	href?: string;
	token?: { use_id: string; input_id: string; occurrence_id: string };
	/** Set on the labelled inert-image placeholder so readers can expose it as an image. */
	image?: { label: string };
}

export interface PublicTextUse {
	id: string;
	input_id: string;
	token: string;
	/** Author-only resolved value. Omit to display the declaration token itself. */
	value?: string;
}

export interface PublicTextOptions {
	format?: 'markdown' | 'text';
	uses?: readonly PublicTextUse[];
	labelImages?: boolean;
}

export type PublicTextBlock =
	| { kind: 'heading'; depth: number; spans: PublicTextSpan[] }
	| { kind: 'paragraph'; quote_depth: number; spans: PublicTextSpan[] }
	| { kind: 'code'; spans: PublicTextSpan[] }
	| { kind: 'list_item'; depth: number; ordered: boolean; index: number; spans: PublicTextSpan[] }
	| { kind: 'table'; rows: PublicTextSpan[][][] }
	| { kind: 'break' };

interface MdNode {
	type?: string;
	value?: string;
	url?: string;
	depth?: number;
	ordered?: boolean;
	start?: number | null;
	children?: MdNode[];
	identifier?: string;
}

type TokenOccurrence = PublicTextUse & { start: number; end: number; ordinal: number };

/** Every unescaped occurrence of each declared token, in source order. */
export function declaredPublicTextOccurrences(
	text: string,
	uses: readonly PublicTextUse[]
): TokenOccurrence[] {
	const matches: TokenOccurrence[] = [];
	for (const use of uses) {
		if (!use.token) continue;
		let from = 0;
		while (from < text.length) {
			const start = text.indexOf(use.token, from);
			if (start < 0) break;
			if (start === 0 || text[start - 1] !== '\\')
				matches.push({ ...use, start, end: start + use.token.length, ordinal: 0 });
			from = start + use.token.length;
		}
	}
	matches.sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id));
	const result: TokenOccurrence[] = [];
	let end = -1;
	const ordinals = new Map<string, number>();
	for (const match of matches) {
		if (match.start < end) continue;
		const ordinal = ordinals.get(match.id) ?? 0;
		result.push({ ...match, ordinal });
		ordinals.set(match.id, ordinal + 1);
		end = match.end;
	}
	return result;
}

function markTokens(source: string, uses: readonly PublicTextUse[]) {
	const active = declaredPublicTextOccurrences(source, uses);
	const byStart = new Map(active.map((occurrence) => [occurrence.start, occurrence]));
	const matches: Array<TokenOccurrence & { escaped: boolean }> = [];
	for (const use of uses) {
		if (!use.token) continue;
		for (let from = 0; from < source.length;) {
			const start = source.indexOf(use.token, from);
			if (start < 0) break;
			const occurrence = byStart.get(start);
			matches.push({
				...(occurrence ?? { ...use, start, end: start + use.token.length, ordinal: -1 }),
				escaped: start > 0 && source[start - 1] === '\\'
			});
			from = start + 1;
		}
	}
	matches.sort((a, b) => a.start - b.start || a.end - b.end);
	for (let index = 1; index < matches.length; index++)
		if (matches[index].start < matches[index - 1].end)
			throw new Error('Declared token occurrences overlap');
	let marker = '\uE000';
	while (source.includes(marker)) marker += '\uE001';
	let marked = '';
	let at = 0;
	for (const match of matches) {
		marked += source.slice(at, match.escaped ? match.start - 1 : match.start);
		if (match.escaped) marked += match.token;
		else {
			const index = active.findIndex(
				(occurrence) => occurrence.start === match.start && occurrence.id === match.id
			);
			marked += `${marker}s${index}${marker}${match.value ?? match.token}${marker}e${index}${marker}`;
		}
		at = match.end;
	}
	return { source: marked + source.slice(at), marker, occurrences: active };
}

function safeHref(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
			? url.href
			: undefined;
	} catch {
		return undefined;
	}
}

function spans(
	nodes: MdNode[],
	style: Omit<PublicTextSpan, 'text' | 'href' | 'token'> = {},
	marked?: ReturnType<typeof markTokens>,
	definitions = new Map<string, string>(),
	state = { active: [] as number[], emitted: new Set<number>() },
	labelImages = false
): PublicTextSpan[] {
	const result: PublicTextSpan[] = [];
	for (const node of nodes) {
		if (node.type === 'image' || node.type === 'imageReference') {
			const destination =
				node.type === 'image' ? node.url : definitions.get(node.identifier?.toLowerCase() ?? '');
			const alt = (node as MdNode & { alt?: string }).alt ?? '';
			const activeIndex = state.active.at(-1);
			const activeOccurrence =
				activeIndex === undefined ? undefined : marked?.occurrences[activeIndex];
			const imageLabel = `${alt ? `${alt} — ` : ''}${destination ?? ''}`;
			result.push({
				text: labelImages ? `Image (not loaded): ${imageLabel}` : '[image suppressed]',
				...style,
				...(labelImages ? { image: { label: imageLabel } } : {}),
				...(activeOccurrence ? { token: occurrenceToken(activeOccurrence) } : {})
			});
			if (activeOccurrence) state.emitted.add(activeIndex!);
			continue;
		}
		if (node.type === 'text' || node.type === 'html') {
			const value = node.value ?? '';
			result.push(...markedSpans(value, style, marked, state));
			continue;
		}
		if (node.type === 'inlineCode') {
			result.push(...markedSpans(node.value ?? '', { ...style, code: true }, marked, state));
			continue;
		}
		if (node.type === 'break') {
			result.push({ text: '\n', ...style });
			continue;
		}
		if (node.type === 'link' || node.type === 'linkReference') {
			const rawDestination =
				node.type === 'link' ? node.url : definitions.get(node.identifier?.toLowerCase() ?? '');
			const destination = marked
				? stripMarkers(rawDestination ?? '', marked, state)
				: { value: rawDestination ?? '', indexes: [] };
			const link = safeHref(destination.value);
			result.push(
				...spans(node.children ?? [], style, marked, definitions, state, labelImages).map(
					(span) => ({
						...span,
						...(link && !span.token ? { href: link } : {})
					})
				)
			);
			for (const index of destination.indexes) {
				const occurrence = marked?.occurrences[index];
				if (occurrence)
					result.push({
						text: occurrence.value ?? occurrence.token,
						...style,
						token: occurrenceToken(occurrence)
					});
			}
			continue;
		}
		if (node.type === 'strong' || node.type === 'emphasis' || node.type === 'delete') {
			result.push(
				...spans(
					node.children ?? [],
					{
						...style,
						...(node.type === 'strong' ? { strong: true } : {}),
						...(node.type === 'emphasis' ? { emphasis: true } : {}),
						...(node.type === 'delete' ? { deleted: true } : {})
					},
					marked,
					definitions,
					state,
					labelImages
				)
			);
			continue;
		}
		// Unknown inline constructs never become elements or attributes. Preserve
		// only allowlisted descendants as inert text.
		result.push(...spans(node.children ?? [], style, marked, definitions, state, labelImages));
	}
	return result;
}

function markedSpans(
	value: string,
	style: Omit<PublicTextSpan, 'text' | 'href' | 'token'>,
	marked?: ReturnType<typeof markTokens>,
	state = { active: [] as number[], emitted: new Set<number>() }
): PublicTextSpan[] {
	if (!marked) return [{ text: value, ...style }];
	if (!value.includes(marked.marker)) {
		const index = state.active.at(-1);
		const occurrence = index === undefined ? undefined : marked.occurrences[index];
		if (occurrence) state.emitted.add(index!);
		return [
			{ text: value, ...style, ...(occurrence ? { token: occurrenceToken(occurrence) } : {}) }
		];
	}
	const result: PublicTextSpan[] = [];
	let at = 0;
	const pattern = new RegExp(`${marked.marker}([se])(\\d+)${marked.marker}`, 'g');
	for (const match of value.matchAll(pattern)) {
		if (match.index! > at) {
			const text = value.slice(at, match.index);
			const index = state.active.at(-1);
			const occurrence = index === undefined ? undefined : marked.occurrences[index];
			result.push({
				text,
				...style,
				...(occurrence ? { token: occurrenceToken(occurrence) } : {})
			});
			if (occurrence) state.emitted.add(index!);
		}
		const index = Number(match[2]);
		if (match[1] === 's') state.active.push(index);
		else {
			if (!state.emitted.has(index) && marked.occurrences[index])
				result.push({ text: '', ...style, token: occurrenceToken(marked.occurrences[index]) });
			state.active = state.active.filter((item) => item !== index);
		}
		at = match.index! + match[0].length;
	}
	if (at < value.length) {
		const text = value.slice(at);
		const index = state.active.at(-1);
		const occurrence = index === undefined ? undefined : marked.occurrences[index];
		result.push({ text, ...style, ...(occurrence ? { token: occurrenceToken(occurrence) } : {}) });
		if (occurrence) state.emitted.add(index!);
	}
	return result;
}

function occurrenceToken(occurrence: TokenOccurrence) {
	return {
		use_id: occurrence.id,
		input_id: occurrence.input_id,
		occurrence_id: `${occurrence.id}:${occurrence.ordinal}`
	};
}

function stripMarkers(
	value: string,
	marked: ReturnType<typeof markTokens>,
	state: { active: number[]; emitted: Set<number> }
) {
	const indexes: number[] = [];
	const pattern = new RegExp(`${marked.marker}([se])(\\d+)${marked.marker}`, 'g');
	const clean = value.replace(pattern, (_match, edge: string, rawIndex: string) => {
		const index = Number(rawIndex);
		if (edge === 's') {
			state.active.push(index);
			indexes.push(index);
		} else state.active = state.active.filter((item) => item !== index);
		return '';
	});
	return { value: clean, indexes: [...new Set(indexes)] };
}

function blockSpans(
	node: MdNode,
	marked: ReturnType<typeof markTokens>,
	definitions: Map<string, string>,
	state: { active: number[]; emitted: Set<number> },
	labelImages: boolean
): PublicTextSpan[] {
	const result: PublicTextSpan[] = [];
	for (const child of node.children ?? []) {
		if (result.length && child.type === 'paragraph') result.push({ text: '\n' });
		if (child.type === 'list') continue;
		result.push(
			...spans(
				child.children ?? (child.value !== undefined ? [child] : []),
				{},
				marked,
				definitions,
				state,
				labelImages
			)
		);
	}
	return result;
}

/** Parse publisher Markdown into a closed, resource-free rendering model. */
export function publicTextModel(
	source: string,
	options: PublicTextOptions = {}
): PublicTextBlock[] {
	const marked = markTokens(source, options.uses ?? []);
	const state = { active: [] as number[], emitted: new Set<number>() };
	if (options.format === 'text') {
		return [
			{
				kind: 'paragraph',
				quote_depth: 0,
				spans: spans([{ type: 'text', value: marked.source }], {}, marked, new Map(), state)
			}
		];
	}
	const root = fromMarkdown(marked.source, {
		extensions: [gfm()],
		mdastExtensions: [gfmFromMarkdown()]
	}) as MdNode;
	const definitions = new Map<string, string>();
	for (const node of root.children ?? []) {
		if (node.type === 'definition' && node.identifier && node.url)
			definitions.set(node.identifier.toLowerCase(), node.url);
	}
	const result: PublicTextBlock[] = [];
	const visit = (nodes: MdNode[], quoteDepth = 0, listDepth = 0) => {
		for (const node of nodes) {
			if (node.type === 'heading') {
				result.push({
					kind: 'heading',
					depth: Math.min(6, Math.max(1, node.depth ?? 1)),
					spans: spans(node.children ?? [], {}, marked, definitions, state, options.labelImages)
				});
			} else if (node.type === 'paragraph') {
				result.push({
					kind: 'paragraph',
					quote_depth: quoteDepth,
					spans: spans(node.children ?? [], {}, marked, definitions, state, options.labelImages)
				});
			} else if (node.type === 'code') {
				result.push({
					kind: 'code',
					spans: markedSpans(node.value ?? '', { code: true }, marked, state)
				});
			} else if (node.type === 'thematicBreak') {
				result.push({ kind: 'break' });
			} else if (node.type === 'blockquote') {
				visit(node.children ?? [], quoteDepth + 1, listDepth);
			} else if (node.type === 'list') {
				(node.children ?? []).forEach((item, offset) => {
					result.push({
						kind: 'list_item',
						depth: listDepth,
						ordered: node.ordered === true,
						index: (node.start ?? 1) + offset,
						spans: blockSpans(item, marked, definitions, state, options.labelImages ?? false)
					});
					visit(
						(item.children ?? []).filter((child) => child.type === 'list'),
						quoteDepth,
						listDepth + 1
					);
				});
			} else if (node.type === 'table') {
				result.push({
					kind: 'table',
					rows: (node.children ?? []).map((row) =>
						(row.children ?? []).map((cell) =>
							spans(cell.children ?? [], {}, marked, definitions, state, options.labelImages)
						)
					)
				});
			}
		}
	};
	visit(root.children ?? []);
	return result;
}

/** Count only rendered words; adjacent styled spans remain one text run. */
export function renderedPublicTextWordCount(
	source: string,
	options: PublicTextOptions = {}
): number {
	const rendered = publicTextModel(source, options)
		.map((block) => {
			if ('spans' in block) return block.spans.map((span) => span.text).join('');
			if (block.kind === 'table')
				return block.rows
					.map((row) => row.map((cell) => cell.map((span) => span.text).join('')).join(' '))
					.join('\n');
			return '';
		})
		.join('\n');
	return rendered.match(/\S+/gu)?.length ?? 0;
}

function atomicSpanKey(span: PublicTextSpan): string | null {
	return span.href ?? span.token?.occurrence_id ?? (span.code ? 'code' : null);
}

/** Cut a parsed model at rendered-word boundaries while keeping unsafe-to-split nodes atomic. */
export function truncatePublicTextModel(
	blocks: readonly PublicTextBlock[],
	maxWords: number
): PublicTextBlock[] {
	const result: PublicTextBlock[] = [];
	let remaining = maxWords;
	for (const block of blocks) {
		if (remaining <= 0) break;
		if ('spans' in block) {
			const text = block.spans.map((span) => span.text).join('');
			const words = [...text.matchAll(/\S+/gu)];
			if (words.length <= remaining) {
				result.push(block);
				remaining -= words.length;
				continue;
			}
			const last = words[remaining - 1];
			const cutAt = (last.index ?? 0) + last[0].length;
			const spans: PublicTextSpan[] = [];
			let offset = 0;
			for (let index = 0; index < block.spans.length; index++) {
				const span = block.spans[index];
				const key = atomicSpanKey(span);
				let end = offset + span.text.length;
				let groupEnd = index;
				while (
					key &&
					groupEnd + 1 < block.spans.length &&
					atomicSpanKey(block.spans[groupEnd + 1]) === key
				) {
					groupEnd++;
					end += block.spans[groupEnd].text.length;
				}
				if (offset >= cutAt) break;
				if (key && end > cutAt) {
					spans.push({ text: '[content omitted]' });
					break;
				}
				if (end <= cutAt) spans.push(...block.spans.slice(index, groupEnd + 1));
				else spans.push({ ...span, text: `${span.text.slice(0, cutAt - offset)}…` });
				offset = end;
				index = groupEnd;
			}
			result.push({ ...block, spans });
			remaining = 0;
			continue;
		}
		if (block.kind === 'table') {
			const rows: typeof block.rows = [];
			for (const row of block.rows) {
				const count =
					row
						.map((cell) => cell.map((span) => span.text).join(''))
						.join(' ')
						.match(/\S+/gu)?.length ?? 0;
				if (count > remaining) break;
				rows.push(row);
				remaining -= count;
			}
			if (rows.length) result.push({ ...block, rows });
			if (rows.length < block.rows.length) {
				result.push({
					kind: 'paragraph',
					quote_depth: 0,
					spans: [{ text: '[table row omitted]' }]
				});
				remaining = 0;
			}
			continue;
		}
		result.push(block);
	}
	return result;
}
