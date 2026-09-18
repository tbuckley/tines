import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { canonicalizeLibraryValue } from './canonical.js';
import { parseLibraryV3Document } from './parse.js';
import type { WorkflowPackageDocument } from './types.js';
import {
	PUBLIC_WORKFLOW_MAX_BYTES,
	publicationBytesSha256,
	type PublicationDiagnostic
} from '../publications.js';

const FORBIDDEN_EXTENSIONS = new Set([
	'.7z',
	'.app',
	'.avi',
	'.bat',
	'.bin',
	'.bmp',
	'.bz2',
	'.cmd',
	'.com',
	'.dll',
	'.dmg',
	'.doc',
	'.docx',
	'.exe',
	'.gif',
	'.gz',
	'.htm',
	'.html',
	'.ico',
	'.iso',
	'.jar',
	'.jpeg',
	'.jpg',
	'.js',
	'.m4a',
	'.mkv',
	'.mov',
	'.mp3',
	'.mp4',
	'.msi',
	'.ogg',
	'.pdf',
	'.png',
	'.ps1',
	'.rar',
	'.sh',
	'.svg',
	'.tar',
	'.tif',
	'.tiff',
	'.ts',
	'.wav',
	'.webm',
	'.webp',
	'.woff',
	'.woff2',
	'.xls',
	'.xlsx',
	'.xml',
	'.xz',
	'.zip'
]);
const BINARY_SIGNATURES = [
	/^\x7fELF/u,
	/^MZ/u,
	/^PK\x03\x04/u,
	/^\x1f\x8b/u,
	/^%PDF-/u,
	/^\x89PNG/u,
	/^GIF8[79]a/u,
	/^\xff\xd8\xff/u
];

function diagnostic(
	path: string,
	code: string,
	message: string,
	identity: { record_id?: string; file_id?: string } = {}
): PublicationDiagnostic {
	return {
		path,
		code,
		message,
		required: true,
		actions: ['repair_source', 'replace_file'],
		...identity
	};
}

function textDiagnostics(
	value: string,
	path: string,
	markdown: boolean,
	identity: { record_id?: string; file_id?: string } = {}
): PublicationDiagnostic[] {
	const result: PublicationDiagnostic[] = [];
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))
		result.push(
			diagnostic(
				path,
				'forbidden_control',
				'Text contains a disallowed control character',
				identity
			)
		);
	if (!markdown) return result;
	const root = fromMarkdown(value, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
	const visit = (node: { type?: string; children?: unknown[] }) => {
		if (node.type === 'image' || node.type === 'imageReference')
			result.push(
				diagnostic(
					path,
					'markdown_image',
					'Markdown images are not allowed in public snapshots',
					identity
				)
			);
		for (const child of node.children ?? [])
			visit(child as { type?: string; children?: unknown[] });
	};
	visit(root);
	return result;
}

function extension(path: string): string {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const index = name.lastIndexOf('.');
	return index < 0 ? '' : name.slice(index).toLowerCase();
}

export function validatePublicWorkflowDocument(
	document: WorkflowPackageDocument
): PublicationDiagnostic[] {
	const result: PublicationDiagnostic[] = [];
	for (const [wi, workflow] of document.workflows.entries()) {
		const base = `/workflows/${wi}`;
		result.push(
			...textDiagnostics(workflow.name, `${base}/name`, false, { record_id: workflow.id })
		);
		result.push(
			...textDiagnostics(workflow.description, `${base}/description`, true, {
				record_id: workflow.id
			})
		);
		for (const [si, state] of workflow.states.entries())
			result.push(
				...textDiagnostics(state.name, `${base}/states/${si}/name`, false, { record_id: state.id })
			);
		for (const [ti, transition] of workflow.transitions.entries()) {
			result.push(
				...textDiagnostics(transition.name, `${base}/transitions/${ti}/name`, false, {
					record_id: transition.id
				})
			);
			for (const [ri, requirement] of transition.requires.entries())
				result.push(
					...textDiagnostics(
						requirement.description ?? '',
						`${base}/transitions/${ti}/requires/${ri}/description`,
						true,
						{ record_id: transition.id }
					)
				);
		}
	}
	for (const [ci, context] of document.context.entries()) {
		const base = `/context/${ci}`;
		const identity = { record_id: context.id };
		result.push(...textDiagnostics(context.name, `${base}/name`, false, identity));
		result.push(...textDiagnostics(context.description, `${base}/description`, true, identity));
		if (context.kind === 'prompt')
			result.push(...textDiagnostics(context.body, `${base}/body`, true, identity));
		if (context.kind === 'skill') {
			const seen = new Set<string>();
			for (const [fi, file] of context.files.entries()) {
				const path = `${base}/files/${fi}`;
				const fileIdentity = { record_id: context.id, file_id: file.id };
				const folded = file.path.normalize('NFC').toLocaleLowerCase('en-US');
				if (seen.has(folded))
					result.push(
						diagnostic(
							`${path}/path`,
							'path_case_collision',
							'Skill file paths collide case-insensitively',
							fileIdentity
						)
					);
				seen.add(folded);
				const ext = extension(file.path);
				if (ext !== '.md' && ext !== '.txt')
					result.push(
						diagnostic(
							`${path}/path`,
							FORBIDDEN_EXTENSIONS.has(ext) ? 'forbidden_file_type' : 'unsupported_file_type',
							'Public skill files must end in .md or .txt',
							fileIdentity
						)
					);
				if (
					/^#!\s*\/?(?:usr\/bin\/env\s+)?[\w.-]+/u.test(file.content) ||
					BINARY_SIGNATURES.some((signature) => signature.test(file.content))
				)
					result.push(
						diagnostic(
							`${path}/content`,
							'executable_or_binary',
							'Executable, archive, media, and binary content is not allowed',
							fileIdentity
						)
					);
				result.push(
					...textDiagnostics(file.content, `${path}/content`, ext === '.md', fileIdentity)
				);
			}
		}
	}
	for (const [ii, input] of document.inputs.entries()) {
		const base = `/inputs/${ii}`;
		result.push(...textDiagnostics(input.label, `${base}/label`, false, { record_id: input.id }));
		result.push(
			...textDiagnostics(input.description, `${base}/description`, true, { record_id: input.id })
		);
		if (input.default !== null)
			result.push(
				...textDiagnostics(input.default, `${base}/default`, false, { record_id: input.id })
			);
		for (const [ri, state] of (input.required_states ?? []).entries())
			result.push(
				...textDiagnostics(state, `${base}/required_states/${ri}`, false, { record_id: input.id })
			);
	}
	for (const [si, schedule] of document.schedules.entries()) {
		const base = `/schedules/${si}`;
		result.push(
			...textDiagnostics(schedule.name, `${base}/name`, false, { record_id: schedule.id })
		);
		result.push(
			...textDiagnostics(schedule.title_template, `${base}/title_template`, false, {
				record_id: schedule.id
			})
		);
		result.push(
			...textDiagnostics(schedule.description_template, `${base}/description_template`, true, {
				record_id: schedule.id
			})
		);
	}
	return result;
}

export async function parsePublicWorkflowDocument(input: string | Uint8Array): Promise<{
	document: WorkflowPackageDocument;
	canonical_json: string;
	byte_length: number;
	bytes_sha256: string;
	diagnostics: PublicationDiagnostic[];
}> {
	const document = await parseLibraryV3Document(input);
	if (document.profile !== 'workflow') throw new Error('Only workflow packages can be published');
	const canonicalJson = canonicalizeLibraryValue(document);
	const byteLength = new TextEncoder().encode(canonicalJson).byteLength;
	if (byteLength > PUBLIC_WORKFLOW_MAX_BYTES)
		throw new Error(`Public workflow exceeds ${PUBLIC_WORKFLOW_MAX_BYTES} bytes`);
	return {
		document,
		canonical_json: canonicalJson,
		byte_length: byteLength,
		bytes_sha256: await publicationBytesSha256(canonicalJson),
		diagnostics: validatePublicWorkflowDocument(document)
	};
}
