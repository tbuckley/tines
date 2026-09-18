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
}

export interface PublicTextUse {
	id: string;
	input_id: string;
	token: string;
}

export interface PublicTextOptions {
	format?: 'markdown' | 'text';
	uses?: readonly PublicTextUse[];
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

type TokenOccurrence = PublicTextUse & { start: number; end: number };

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
			let slashes = 0;
			for (let at = start - 1; at >= 0 && text[at] === '\\'; at--) slashes++;
			if (slashes % 2 === 0) matches.push({ ...use, start, end: start + use.token.length });
			from = start + use.token.length;
		}
	}
	matches.sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id));
	const result: TokenOccurrence[] = [];
	let end = -1;
	for (const match of matches) {
		if (match.start < end) continue;
		result.push(match);
		end = match.end;
	}
	return result;
}

function markTokens(source: string, uses: readonly PublicTextUse[]) {
	const occurrences = declaredPublicTextOccurrences(source, uses);
	let marker = '\uE000';
	while (source.includes(marker)) marker += '\uE001';
	let marked = '';
	let at = 0;
	for (const [index, occurrence] of occurrences.entries()) {
		marked += source.slice(at, occurrence.start) + `${marker}${index}${marker}`;
		at = occurrence.end;
	}
	return { source: marked + source.slice(at), marker, occurrences };
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
	definitions = new Map<string, string>()
): PublicTextSpan[] {
	const result: PublicTextSpan[] = [];
	for (const node of nodes) {
		if (node.type === 'image' || node.type === 'imageReference') {
			result.push({ text: '[image suppressed]', ...style });
			continue;
		}
		if (node.type === 'text' || node.type === 'html') {
			const value = node.value ?? '';
			if (!marked || !value.includes(marked.marker)) result.push({ text: value, ...style });
			else {
				let at = 0;
				const pattern = new RegExp(`${marked.marker}(\\d+)${marked.marker}`, 'g');
				for (const match of value.matchAll(pattern)) {
					if (match.index! > at) result.push({ text: value.slice(at, match.index), ...style });
					const occurrence = marked.occurrences[Number(match[1])];
					if (occurrence)
						result.push({
							text: occurrence.token,
							...style,
							token: {
								use_id: occurrence.id,
								input_id: occurrence.input_id,
								occurrence_id: `public-token-${match[1]}`
							}
						});
					at = match.index! + match[0].length;
				}
				if (at < value.length) result.push({ text: value.slice(at), ...style });
			}
			continue;
		}
		if (node.type === 'inlineCode') {
			result.push(...markedSpans(node.value ?? '', { ...style, code: true }, marked));
			continue;
		}
		if (node.type === 'break') {
			result.push({ text: '\n', ...style });
			continue;
		}
		if (node.type === 'link' || node.type === 'linkReference') {
			const link = safeHref(
				node.type === 'link' ? node.url : definitions.get(node.identifier?.toLowerCase() ?? '')
			);
			result.push(
				...spans(node.children ?? [], style, marked, definitions).map((span) => ({
					...span,
					...(link && !span.token ? { href: link } : {})
				}))
			);
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
					definitions
				)
			);
			continue;
		}
		// Unknown inline constructs never become elements or attributes. Preserve
		// only allowlisted descendants as inert text.
		result.push(...spans(node.children ?? [], style, marked, definitions));
	}
	return result;
}

function markedSpans(
	value: string,
	style: Omit<PublicTextSpan, 'text' | 'href' | 'token'>,
	marked?: ReturnType<typeof markTokens>
): PublicTextSpan[] {
	if (!marked || !value.includes(marked.marker)) return [{ text: value, ...style }];
	const result: PublicTextSpan[] = [];
	let at = 0;
	const pattern = new RegExp(`${marked.marker}(\\d+)${marked.marker}`, 'g');
	for (const match of value.matchAll(pattern)) {
		if (match.index! > at) result.push({ text: value.slice(at, match.index), ...style });
		const occurrence = marked.occurrences[Number(match[1])];
		if (occurrence)
			result.push({
				text: occurrence.token,
				...style,
				token: {
					use_id: occurrence.id,
					input_id: occurrence.input_id,
					occurrence_id: `public-token-${match[1]}`
				}
			});
		at = match.index! + match[0].length;
	}
	if (at < value.length) result.push({ text: value.slice(at), ...style });
	return result;
}

function blockSpans(
	node: MdNode,
	marked: ReturnType<typeof markTokens>,
	definitions: Map<string, string>
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
				definitions
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
	if (options.format === 'text') {
		return [
			{
				kind: 'paragraph',
				quote_depth: 0,
				spans: spans([{ type: 'text', value: marked.source }], {}, marked)
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
					spans: spans(node.children ?? [], {}, marked, definitions)
				});
			} else if (node.type === 'paragraph') {
				result.push({
					kind: 'paragraph',
					quote_depth: quoteDepth,
					spans: spans(node.children ?? [], {}, marked, definitions)
				});
			} else if (node.type === 'code') {
				result.push({ kind: 'code', spans: markedSpans(node.value ?? '', { code: true }, marked) });
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
						spans: blockSpans(item, marked, definitions)
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
						(row.children ?? []).map((cell) => spans(cell.children ?? [], {}, marked, definitions))
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
