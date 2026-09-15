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
}

export type PublicTextBlock =
	| { kind: 'heading'; depth: number; spans: PublicTextSpan[] }
	| { kind: 'paragraph'; quote_depth: number; spans: PublicTextSpan[] }
	| { kind: 'code'; value: string }
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
	style: Omit<PublicTextSpan, 'text' | 'href'> = {}
): PublicTextSpan[] {
	const result: PublicTextSpan[] = [];
	for (const node of nodes) {
		if (node.type === 'image' || node.type === 'imageReference') {
			result.push({ text: '[image suppressed]', ...style });
			continue;
		}
		if (node.type === 'text' || node.type === 'html') {
			result.push({ text: node.value ?? '', ...style });
			continue;
		}
		if (node.type === 'inlineCode') {
			result.push({ text: node.value ?? '', ...style, code: true });
			continue;
		}
		if (node.type === 'break') {
			result.push({ text: '\n', ...style });
			continue;
		}
		if (node.type === 'link') {
			const link = safeHref(node.url);
			result.push(
				...spans(node.children ?? [], style).map((span) => ({
					...span,
					...(link ? { href: link } : {})
				}))
			);
			continue;
		}
		if (node.type === 'linkReference') {
			result.push(...spans(node.children ?? [], style));
			continue;
		}
		if (node.type === 'strong' || node.type === 'emphasis' || node.type === 'delete') {
			result.push(
				...spans(node.children ?? [], {
					...style,
					...(node.type === 'strong' ? { strong: true } : {}),
					...(node.type === 'emphasis' ? { emphasis: true } : {}),
					...(node.type === 'delete' ? { deleted: true } : {})
				})
			);
			continue;
		}
		// Unknown inline constructs never become elements or attributes. Preserve
		// only allowlisted descendants as inert text.
		result.push(...spans(node.children ?? [], style));
	}
	return result;
}

function blockSpans(node: MdNode): PublicTextSpan[] {
	const result: PublicTextSpan[] = [];
	for (const child of node.children ?? []) {
		if (result.length && child.type === 'paragraph') result.push({ text: '\n' });
		result.push(...spans(child.children ?? (child.value !== undefined ? [child] : [])));
	}
	return result;
}

/** Parse publisher Markdown into a closed, resource-free rendering model. */
export function publicTextModel(source: string): PublicTextBlock[] {
	const root = fromMarkdown(source, {
		extensions: [gfm()],
		mdastExtensions: [gfmFromMarkdown()]
	}) as MdNode;
	const result: PublicTextBlock[] = [];
	const visit = (nodes: MdNode[], quoteDepth = 0, listDepth = 0) => {
		for (const node of nodes) {
			if (node.type === 'heading') {
				result.push({
					kind: 'heading',
					depth: Math.min(6, Math.max(1, node.depth ?? 1)),
					spans: spans(node.children ?? [])
				});
			} else if (node.type === 'paragraph') {
				result.push({
					kind: 'paragraph',
					quote_depth: quoteDepth,
					spans: spans(node.children ?? [])
				});
			} else if (node.type === 'code') {
				result.push({ kind: 'code', value: node.value ?? '' });
			} else if (node.type === 'thematicBreak') {
				result.push({ kind: 'break' });
			} else if (node.type === 'blockquote') {
				visit(node.children ?? [], quoteDepth + 1, listDepth);
			} else if (node.type === 'list') {
				(node.children ?? []).forEach((item, offset) =>
					result.push({
						kind: 'list_item',
						depth: listDepth,
						ordered: node.ordered === true,
						index: (node.start ?? 1) + offset,
						spans: blockSpans(item)
					})
				);
			} else if (node.type === 'table') {
				result.push({
					kind: 'table',
					rows: (node.children ?? []).map((row) =>
						(row.children ?? []).map((cell) => spans(cell.children ?? []))
					)
				});
			}
		}
	};
	visit(root.children ?? []);
	return result;
}
