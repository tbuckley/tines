import {
	CONTEXT_DESCRIPTION_MAX_LENGTH,
	CONTEXT_NAME_MAX_LENGTH,
	SKILL_MAX_TOTAL_BYTES,
	SKILL_NAME_PATTERN
} from '@tines/shared';

export interface SkillMetadataCandidates {
	name?: string;
	description?: string;
}

const byteLength = (value: string) => new TextEncoder().encode(value).length;

function frontMatterOf(content: string): string | null {
	const withoutBom = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
	let bodyStart: number;
	if (withoutBom.startsWith('---\r\n')) bodyStart = 5;
	else if (withoutBom.startsWith('---\n')) bodyStart = 4;
	else return null;

	const remainder = withoutBom.slice(bodyStart);
	const closing = /(?:^|\r?\n)---(?=\r?\n|$)/.exec(remainder);
	if (!closing) return null;
	const frontMatter = remainder.slice(0, closing.index);
	return byteLength(frontMatter) <= SKILL_MAX_TOTAL_BYTES ? frontMatter : null;
}

/**
 * Read optional metadata from a root SKILL.md without making metadata a
 * requirement of the folder import. The parser stays out of initial route
 * chunks and every parser/load failure falls back to manual entry.
 */
export async function readSkillMetadata(content: string): Promise<SkillMetadataCandidates> {
	const frontMatter = frontMatterOf(content);
	if (frontMatter === null || /(?:^|\r?\n)%/.test(frontMatter)) return {};

	try {
		const { isMap, isScalar, parseDocument, visit } = await import('yaml');
		const document = parseDocument(frontMatter, {
			version: '1.2',
			schema: 'core',
			strict: true,
			uniqueKeys: true,
			merge: false,
			customTags: [],
			resolveKnownTags: false,
			prettyErrors: false
		});
		if (document.errors.length > 0 || document.warnings.length > 0 || !isMap(document.contents)) {
			return {};
		}

		let unsupported = false;
		visit(document, {
			Alias: () => {
				unsupported = true;
			},
			Node: (_key, node) => {
				if ('tag' in node && node.tag) unsupported = true;
			},
			Pair: (_key, pair) => {
				if (isScalar(pair.key) && pair.key.value === '<<') unsupported = true;
			}
		});
		if (unsupported) return {};

		const parsed = document.toJS({ mapAsMap: true, maxAliasCount: 0 });
		if (!(parsed instanceof Map)) return {};

		const candidates: SkillMetadataCandidates = {};
		const rawName = parsed.get('name');
		if (typeof rawName === 'string') {
			const name = rawName.trim();
			if (
				name.length > 0 &&
				name.length <= CONTEXT_NAME_MAX_LENGTH &&
				SKILL_NAME_PATTERN.test(name)
			) {
				candidates.name = name;
			}
		}

		const description = parsed.get('description');
		if (
			typeof description === 'string' &&
			description.trim().length > 0 &&
			description.length <= CONTEXT_DESCRIPTION_MAX_LENGTH &&
			!/[\r\n]/.test(description)
		) {
			candidates.description = description;
		}

		return candidates;
	} catch {
		return {};
	}
}
