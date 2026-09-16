<script lang="ts">
	import {
		ApiError,
		canonicalizeLibraryValue,
		inputToken,
		validatePublicationMetadata,
		withLibraryDocumentDigest,
		type ExportWorkflowPackageOptions,
		type LibraryDiagnostic,
		type ModelTier,
		type PackageInput,
		type PublicationOwnerResult,
		type PublicationProof,
		type PublicationSourceOptions,
		type TextUseField,
		type WorkflowPackageDocument
	} from '@tines/shared';
	import IconArrowLeft from '@tabler/icons-svelte/icons/arrow-left';
	import IconCheck from '@tabler/icons-svelte/icons/check';
	import IconDownload from '@tabler/icons-svelte/icons/download';
	import IconPencil from '@tabler/icons-svelte/icons/pencil';
	import IconRefresh from '@tabler/icons-svelte/icons/refresh';
	import { tick } from 'svelte';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import {
		listEditableFields,
		normalizeInputDraft,
		readField,
		replaceSelectionWithVariable,
		saveAuthoredField,
		updateAuthoredInput,
		writeField,
		type InputDraft
	} from '$lib/components/library/package-input-editor';
	import PackageReview from '$lib/components/library/PackageReview.svelte';
	import TechnicalDetails from '$lib/components/publications/TechnicalDetails.svelte';
	import { PublicationFlowController } from '$lib/components/publications/publication-flow';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';

	let { data } = $props();
	function initialCandidate(): WorkflowPackageDocument {
		return structuredClone(data.candidate);
	}
	function initialBaseline() {
		return { document_digest: data.candidate.digest, exported_at: data.candidate.exported_at };
	}
	let candidate = $state<WorkflowPackageDocument>(initialCandidate());
	let baseline = $state(initialBaseline());
	let appliedSourceOptions = $state<PublicationSourceOptions>({ schedule_ids: [], tiers: [] });
	let sourceProjectId = $state('');
	let selectedSchedules = $state<string[]>([]);
	let tierSelections = $state<Record<string, '' | ModelTier>>({});
	let projectScoped = $state<Record<string, boolean>>({});
	let reviewed = $state<Set<string>>(new Set());
	let diagnostics = $state<LibraryDiagnostic[]>([]);
	let validatedDigest = $state<string | null>(null);
	let busy = $state(false);
	let candidateUpdating = $state(false);
	let dirty = $state(false);
	let status = $state('');
	let candidateGeneration = $state(0);
	let displayName = $state('');
	let publicationProof = $state<PublicationProof | null>(null);
	let publicationResult = $state<PublicationOwnerResult | null>(null);
	let shareConsent = $state(false);
	let step = $state<'customize' | 'preview' | 'share' | 'complete'>('customize');
	const publicationFlow = new PublicationFlowController();
	let stepHeading = $state<HTMLElement | null>(null);
	let displayNameInput = $state<HTMLInputElement | null>(null);
	let displayNameError = $state('');

	let draftKey = $state('');
	let draftType = $state<PackageInput['type']>('text');
	let draftLabel = $state('');
	let draftDescription = $state('');
	let draftDefault = $state('');
	let draftRequired = $state(true);
	let editingInputId = $state<string | null>(null);
	let editingInputKey = $state('');
	let addDraftSnapshot = $state<InputDraft | null>(null);
	let inputFormError = $state('');
	let selectedInputId = $state('');
	let selectedTarget = $state('');
	let fieldEditor = $state<HTMLTextAreaElement | null>(null);
	let fieldEditPending = $state(false);
	let inputPanel = $state<HTMLElement | null>(null);
	let keyEditor = $state<HTMLInputElement | null>(null);
	let tokenInvoker = $state<HTMLElement | null>(null);
	let diagnosticsPanel = $state<HTMLElement | null>(null);
	let samples = $state<Record<string, string>>({});
	let changedInputIds = $state<Set<string>>(new Set());

	const requiredReviews = $derived(
		candidate.context
			.filter((item) => item.kind === 'skill' || item.kind === 'repo')
			.map((item) => item.id)
	);
	const proofRequiredReviews = $derived(
		publicationProof?.document.context.filter(
			(item) => item.kind === 'skill' || item.kind === 'repo'
		) ?? []
	);
	const proofWorkflowName = $derived(
		publicationProof?.document.workflows.find(
			(workflow) => workflow.id === publicationProof?.document.main_workflow_id
		)?.name ?? data.workflow.name
	);
	const reviewComplete = $derived(requiredReviews.every((id) => reviewed.has(id)));
	const availableSchedules = $derived(
		data.schedules.filter((schedule) => schedule.project_id === sourceProjectId)
	);
	const editableFields = $derived(listEditableFields(candidate));
	const selectedField = $derived(editableFields.find((field) => field.key === selectedTarget));
	const selectedInput = $derived(candidate.inputs.find((input) => input.id === selectedInputId));
	const diagnosticFieldKeys = $derived(
		new Set(
			diagnostics
				.map((diagnostic) => diagnosticField(diagnostic.path)?.key)
				.filter((key): key is string => Boolean(key))
		)
	);

	function message(error: unknown) {
		return error instanceof ApiError
			? error.message
			: error instanceof Error
				? error.message
				: 'Something went wrong.';
	}
	function resetReview(note: string) {
		publicationFlow.invalidate();
		candidateGeneration += 1;
		reviewed = new Set();
		validatedDigest = null;
		diagnostics = [];
		status = `${note} Required skill and repository review was reset.`;
		publicationProof = null;
		publicationResult = null;
		shareConsent = false;
		step = 'customize';
	}
	function displayNameChanged(event: Event) {
		displayName = (event.currentTarget as HTMLInputElement).value;
		displayNameError = '';
		publicationFlow.invalidate();
		if (!publicationProof && !busy) return;
		publicationProof = null;
		publicationResult = null;
		shareConsent = false;
		step = 'customize';
		status = 'Your display name changed. Preview this version again.';
	}
	async function focusIncludedReview(id: string, event: MouseEvent) {
		event.preventDefault();
		await tick();
		const target = document.getElementById(`review-${id}`);
		target?.focus({ preventScroll: true });
		target?.scrollIntoView({ block: 'center' });
	}
	function sourceOptions(): PublicationSourceOptions {
		const tiers: NonNullable<ExportWorkflowPackageOptions['tiers']> = [];
		for (const state of data.sourceStates) {
			const tier = tierSelections[state.id];
			if (tier)
				tiers.push({
					state_id: state.id,
					tier,
					project_scoped: projectScoped[state.id] ?? false
				});
		}
		return {
			...(sourceProjectId ? { source_project_id: sourceProjectId } : {}),
			schedule_ids: selectedSchedules,
			tiers
		};
	}
	const pendingSourceSelection = $derived(
		canonicalizeLibraryValue(sourceOptions()) !== canonicalizeLibraryValue(appliedSourceOptions)
	);
	let sourceSelectionSignature = canonicalizeLibraryValue(sourceOptions());
	$effect(() => {
		const signature = canonicalizeLibraryValue(sourceOptions());
		if (signature === sourceSelectionSignature) return;
		sourceSelectionSignature = signature;
		resetReview('Automation choices changed. Apply or revert them before previewing.');
	});
	function setReviewed(id: string, checked: boolean) {
		candidateGeneration += 1;
		const next = new Set(reviewed);
		if (checked) next.add(id);
		else next.delete(id);
		reviewed = next;
	}
	function scheduleChanged(id: string, checked: boolean) {
		selectedSchedules = checked
			? [...selectedSchedules, id]
			: selectedSchedules.filter((item) => item !== id);
	}
	async function rebuild() {
		if (candidateUpdating || busy) return;
		if (editingInputId) {
			status = 'Save or cancel the input edit before rebuilding.';
			return;
		}
		if (fieldEditPending || (fieldEditor && fieldEditor.value !== selectedField?.value)) {
			status = 'Save or cancel the candidate text edit before rebuilding.';
			return;
		}
		if (
			dirty &&
			!confirm('Rebuilding from the source discards candidate-only text and input edits. Continue?')
		)
			return;
		busy = true;
		status = 'Rebuilding the candidate from its private source…';
		try {
			const options = sourceOptions();
			const rebuilt = await api.exportWorkflowPackage(data.workflow.id, options);
			if (!rebuilt.inputs.some((input) => input.id === selectedInputId)) selectedInputId = '';
			candidate = rebuilt;
			samples = {};
			changedInputIds = new Set();
			baseline = { document_digest: rebuilt.digest, exported_at: rebuilt.exported_at };
			appliedSourceOptions = structuredClone(options);
			dirty = false;
			resetReview('Candidate rebuilt from source.');
		} catch (error) {
			status = message(error);
			const details = error instanceof ApiError ? error.details?.diagnostics : null;
			if (Array.isArray(details)) {
				diagnostics = details.filter(
					(item): item is LibraryDiagnostic =>
						!!item &&
						typeof item === 'object' &&
						typeof item.path === 'string' &&
						typeof item.code === 'string' &&
						typeof item.message === 'string'
				);
				await tick();
				diagnosticsPanel?.focus();
			}
		} finally {
			busy = false;
		}
	}
	async function prepareForPublication() {
		if (editingInputId) {
			status = 'Save or cancel the input edit before previewing.';
			return;
		}
		if (fieldEditPending || (fieldEditor && fieldEditor.value !== selectedField?.value)) {
			status = 'Save or cancel the candidate text edit before previewing.';
			return;
		}
		if (candidateUpdating) {
			status = 'Wait for the draft edit to finish before previewing.';
			return;
		}
		if (pendingSourceSelection) {
			status = 'Apply or revert the automation choices before previewing.';
			return;
		}
		try {
			validatePublicationMetadata({
				display_name: displayName,
				license: 'MIT',
				license_year: new Date().getFullYear()
			});
			displayNameError = '';
		} catch {
			displayNameError = 'Enter a name from 1–100 characters. Use a name, not an email address.';
			await tick();
			displayNameInput?.focus();
			return;
		}
		if (publicationFlow.canReuseProof() && publicationProof) {
			step = 'preview';
			await focusStep();
			return;
		}
		if (publicationProof) {
			publicationFlow.invalidate();
			publicationProof = null;
		}
		busy = true;
		status = 'Checking this version…';
		const revision = publicationFlow.revision;
		try {
			const request = publicationFlow.prepareRequest({
				source: {
					kind: 'owned_workflow',
					workflow_id: data.workflow.id,
					options: JSON.parse(
						canonicalizeLibraryValue(appliedSourceOptions)
					) as PublicationSourceOptions,
					draft: {
						version: 1,
						baseline: { ...baseline },
						document_json: canonicalizeLibraryValue(candidate)
					}
				},
				metadata: {
					display_name: displayName,
					license: 'MIT',
					license_year: new Date().getFullYear()
				}
			});
			const proof = await api.preparePublication(request);
			if (!publicationFlow.acceptProof(proof, revision)) {
				if (revision === publicationFlow.revision && proof.expires_at <= Date.now())
					status = 'The preview expired before it was ready. Preview this version again.';
				return;
			}
			publicationProof = proof;
			publicationResult = null;
			shareConsent = false;
			status = 'Ready to review.';
			step = 'preview';
			await focusStep();
		} catch (error) {
			if (revision !== publicationFlow.revision) return;
			status =
				error instanceof ApiError &&
				(error.code === 'publication_source_changed' ||
					error.code === 'publication_source_changing')
					? 'The source changed. Your draft edits are still here. Review the latest source before sharing.'
					: message(error);
			const details = error instanceof ApiError ? error.details?.diagnostics : null;
			if (Array.isArray(details)) {
				diagnostics = details.filter(
					(item): item is LibraryDiagnostic =>
						!!item &&
						typeof item === 'object' &&
						typeof item.path === 'string' &&
						typeof item.code === 'string' &&
						typeof item.message === 'string'
				);
				await tick();
				diagnosticsPanel?.focus();
			}
		} finally {
			busy = false;
		}
	}
	async function focusStep() {
		await tick();
		stepHeading?.focus();
		stepHeading?.scrollIntoView({ block: 'start' });
	}
	async function reviewIncludedAndShare() {
		if (!publicationProof) return;
		publicationFlow.reviewIncluded();
		reviewed = new Set(publicationFlow.reviewedIds);
		shareConsent = false;
		step = 'share';
		status = 'Ready to share.';
		await focusStep();
	}
	async function goTo(next: 'customize' | 'preview' | 'share') {
		step = next;
		await focusStep();
	}
	function consentChanged(event: Event) {
		shareConsent = (event.currentTarget as HTMLInputElement).checked;
		publicationFlow.setConsent(shareConsent);
	}
	async function publish() {
		const request = publicationFlow.publishRequest();
		if (!publicationProof || !request) return;
		busy = true;
		status = 'Publishing…';
		try {
			publicationResult = await api.publishPublication(publicationProof.candidate_id, request);
			status = 'Shared.';
			step = 'complete';
			await focusStep();
		} catch (error) {
			if (
				error instanceof ApiError &&
				(error.code === 'publication_source_changed' ||
					error.code === 'publication_source_changing' ||
					error.code === 'publication_proof_expired' ||
					error.code === 'publication_policy_changed')
			) {
				publicationFlow.invalidate();
				publicationProof = null;
				reviewed = new Set();
				shareConsent = false;
				step = 'customize';
				status =
					error.code === 'publication_source_changed' ||
					error.code === 'publication_source_changing'
						? 'The source changed. Your draft edits are still here. Review the latest source before sharing.'
						: 'Preview this version again before sharing.';
				await focusStep();
			} else if (error instanceof ApiError && error.code !== 'publication_outcome_unknown')
				status = error.message;
			else
				status = 'We could not confirm whether sharing finished. Retry publishing to check safely.';
		} finally {
			busy = false;
		}
	}
	async function addInput() {
		if (candidateUpdating) return;
		let normalized;
		try {
			normalized = normalizeInputDraft(inputDraft());
		} catch (error) {
			status = message(error);
			return;
		}
		if (candidate.inputs.some((input) => input.key === normalized.key)) {
			status = `Input key “${normalized.key}” already exists.`;
			return;
		}
		resetReview('Saving a new variable.');
		candidateUpdating = true;
		const id = `input:author:${candidate.inputs.length + 1}`;
		const next = {
			...candidate,
			inputs: [...candidate.inputs, { id, ...normalized }]
		};
		try {
			candidate = await withLibraryDocumentDigest(next);
		} catch (error) {
			status = message(error);
			return;
		} finally {
			candidateUpdating = false;
		}
		selectedInputId = id;
		dirty = true;
		resetReview('Input declaration added to this candidate only.');
	}
	function inputDraft(): InputDraft {
		return {
			key: draftKey,
			type: draftType,
			label: draftLabel,
			description: draftDescription,
			default: draftDefault,
			required: draftRequired
		};
	}
	function setInputDraft(draft: InputDraft) {
		draftKey = draft.key;
		draftType = draft.type;
		draftLabel = draft.label;
		draftDescription = draft.description;
		draftDefault = draft.default;
		draftRequired = draft.required;
	}
	async function editInput(input: PackageInput) {
		if (busy || candidateUpdating || editingInputId || !input.id.startsWith('input:author:'))
			return;
		addDraftSnapshot = inputDraft();
		editingInputId = input.id;
		editingInputKey = input.key;
		inputFormError = '';
		setInputDraft({
			key: input.key,
			type: input.type,
			label: input.label,
			description: input.description,
			default: input.default ?? '',
			required: input.required
		});
		await tick();
		keyEditor?.focus();
		keyEditor?.scrollIntoView({ block: 'center' });
	}
	async function finishInputEdit(inputId: string) {
		if (addDraftSnapshot) setInputDraft(addDraftSnapshot);
		editingInputId = null;
		editingInputKey = '';
		addDraftSnapshot = null;
		inputFormError = '';
		await tick();
		document.getElementById(`edit-${inputId}`)?.focus();
	}
	async function cancelInputEdit() {
		if (!editingInputId || candidateUpdating) return;
		const inputId = editingInputId;
		await finishInputEdit(inputId);
	}
	async function saveInputEdit() {
		if (!editingInputId || candidateUpdating) return;
		inputFormError = '';
		const inputId = editingInputId;
		const current = candidate.inputs.find((input) => input.id === inputId);
		if (!current) {
			inputFormError = 'Input declaration no longer exists.';
			return;
		}
		let normalized;
		try {
			normalized = normalizeInputDraft(inputDraft());
		} catch (error) {
			inputFormError = message(error);
			return;
		}
		const tokenChanges =
			inputToken(current.key, current.default) !== inputToken(normalized.key, normalized.default);
		const selectedFieldIsAffected = Boolean(
			tokenChanges &&
			selectedField &&
			candidate.text_uses.some(
				(use) =>
					use.input_id === inputId &&
					use.target.record_id === selectedField?.recordId &&
					use.target.field === selectedField.field
			)
		);
		if (selectedFieldIsAffected && fieldEditor && fieldEditor.value !== selectedField?.value) {
			inputFormError = 'Save candidate text before updating this input’s registered tokens.';
			return;
		}
		const pendingField =
			!selectedFieldIsAffected && fieldEditor
				? {
						value: fieldEditor.value,
						start: fieldEditor.selectionStart,
						end: fieldEditor.selectionEnd
					}
				: null;
		const snapshot = candidate;
		let updated: WorkflowPackageDocument;
		try {
			updated = updateAuthoredInput(snapshot, inputId, inputDraft());
		} catch (error) {
			inputFormError = message(error);
			return;
		}
		resetReview('Saving the variable changes.');
		candidateUpdating = true;
		let saved = false;
		try {
			const sealed = await withLibraryDocumentDigest(updated);
			candidate = sealed;
			dirty = true;
			resetReview('Input declaration updated in this candidate only.');
			saved = true;
		} catch (error) {
			inputFormError = message(error);
		} finally {
			candidateUpdating = false;
		}
		if (!saved) return;
		await finishInputEdit(inputId);
		await tick();
		if (fieldEditor) {
			if (selectedFieldIsAffected && selectedField) fieldEditor.value = selectedField.value;
			else if (pendingField) {
				fieldEditor.value = pendingField.value;
				fieldEditor.setSelectionRange(pendingField.start, pendingField.end);
			}
		}
	}
	async function saveCandidateField(addUse = false) {
		if (!selectedField || !fieldEditor) return;
		const input = addUse ? selectedInput : undefined;
		if (addUse && !input) {
			status = 'Choose an input declaration first.';
			return;
		}
		const next = JSON.parse(JSON.stringify(candidate)) as WorkflowPackageDocument;
		resetReview('Saving the draft text.');
		candidateUpdating = true;
		let value = fieldEditor.value;
		if (input) {
			const token = inputToken(input.key, input.default);
			const start = fieldEditor.selectionStart;
			const end = fieldEditor.selectionEnd;
			value = `${value.slice(0, start)}${token}${value.slice(end)}`;
			next.text_uses.push({
				id: `use:author:${next.text_uses.length + 1}`,
				target: { record_id: selectedField.recordId, field: selectedField.field },
				input_id: input.id,
				token
			});
		}
		writeField(next, selectedField.recordId, selectedField.field, value);
		try {
			candidate = await withLibraryDocumentDigest(next);
			dirty = true;
			fieldEditPending = false;
			resetReview(
				addUse
					? 'Exact declared token use added to the draft field.'
					: 'Candidate text updated without changing the private source.'
			);
			await tick();
			if (fieldEditor) fieldEditor.value = value;
		} catch (error) {
			status = message(error);
		} finally {
			candidateUpdating = false;
		}
	}
	async function saveInlineText(recordId: string, field: TextUseField, value: string) {
		if (candidateUpdating) return false;
		let next: WorkflowPackageDocument;
		try {
			next = saveAuthoredField(candidate, { recordId, field }, value);
		} catch (error) {
			status = message(error);
			return false;
		}
		resetReview('Saving the passage text.');
		candidateUpdating = true;
		try {
			candidate = await withLibraryDocumentDigest(next);
			dirty = true;
			changedInputIds = new Set();
			resetReview('Passage text updated in this candidate only.');
			return true;
		} catch (error) {
			status = message(error);
			return false;
		} finally {
			candidateUpdating = false;
		}
	}
	async function createInlineVariable(request: {
		recordId: string;
		field: TextUseField;
		sourceSnapshot: string;
		value: string;
		start: number;
		end: number;
		direction: 'forward' | 'backward' | 'none';
		inputId?: string;
		draft?: InputDraft;
	}) {
		if (candidateUpdating) return null;
		let result;
		try {
			result = replaceSelectionWithVariable(candidate, {
				ref: { recordId: request.recordId, field: request.field },
				sourceSnapshot: request.sourceSnapshot,
				value: request.value,
				start: request.start,
				end: request.end,
				inputId: request.inputId,
				newInput: request.draft
			});
		} catch (error) {
			status = message(error);
			return null;
		}
		resetReview('Saving the new variable use.');
		candidateUpdating = true;
		try {
			candidate = await withLibraryDocumentDigest(result.document);
			selectedInputId = result.inputId;
			dirty = true;
			changedInputIds = new Set([result.inputId]);
			const count = result.document.text_uses
				.filter((use) => use.input_id === result.inputId)
				.reduce((total, use) => {
					const source = readField(result.document, use.target.record_id, use.target.field) ?? '';
					return total + source.split(use.token).length - 1;
				}, 0);
			resetReview(`${count} ${count === 1 ? 'use' : 'uses'} updated.`);
			return result.inputId;
		} catch (error) {
			status = message(error);
			return null;
		} finally {
			candidateUpdating = false;
		}
	}
	async function editInlineVariable(inputId: string, draft: InputDraft) {
		if (candidateUpdating) return false;
		let next: WorkflowPackageDocument;
		try {
			next = updateAuthoredInput(candidate, inputId, draft);
		} catch (error) {
			status = message(error);
			return false;
		}
		resetReview('Saving the variable changes.');
		candidateUpdating = true;
		try {
			candidate = await withLibraryDocumentDigest(next);
			dirty = true;
			changedInputIds = new Set([inputId]);
			resetReview('Input declaration updated in this candidate only.');
			return true;
		} catch (error) {
			status = message(error);
			return false;
		} finally {
			candidateUpdating = false;
		}
	}
	function setSample(inputId: string, value: string | undefined) {
		const next = { ...samples };
		if (value === undefined) delete next[inputId];
		else next[inputId] = value;
		if (JSON.stringify(next) === JSON.stringify(samples)) return;
		samples = next;
		changedInputIds = new Set([inputId]);
		const count = candidate.text_uses.filter((use) => use.input_id === inputId).length;
		status = `${count} ${count === 1 ? 'use' : 'uses'} updated. Sample values do not change the reusable file.`;
	}
	function cancelCandidateField() {
		if (!selectedField || !fieldEditor || candidateUpdating) return;
		fieldEditor.value = selectedField.value;
		fieldEditPending = false;
		status = 'Candidate text edit canceled.';
		fieldEditor.focus();
	}
	type InputRepairField = 'key' | 'default' | 'label' | 'description';
	function diagnosticInput(path: string) {
		const parts = path.split('/').slice(1);
		if (parts[0] !== 'inputs') return null;
		const input = candidate.inputs[Number(parts[1])];
		const field = parts[2] as InputRepairField;
		if (!input?.id.startsWith('input:author:')) return null;
		if (!['key', 'default', 'label', 'description'].includes(field)) return null;
		return { input, field, label: `${input.label || input.key} — ${field}` };
	}
	async function beginInputRepair(input: PackageInput, field: InputRepairField) {
		await editInput(input);
		await tick();
		document.getElementById(`input-editor-${field}`)?.focus();
	}
	function diagnosticField(path: string) {
		const parts = path.split('/').slice(1);
		let recordId: string | undefined;
		let field: TextUseField | undefined;
		if (parts[0] === 'workflows') {
			recordId = candidate.workflows[Number(parts[1])]?.id;
			if (parts[2] === 'description') field = 'description';
		} else if (parts[0] === 'context') {
			const item = candidate.context[Number(parts[1])];
			if (parts[2] === 'files') {
				recordId = item?.kind === 'skill' ? item.files[Number(parts[3])]?.id : undefined;
				if (parts[4] === 'content') field = 'content';
			} else {
				recordId = item?.id;
				if (parts[2] === 'description') field = 'description';
				if (parts[2] === 'body') field = 'body';
			}
		} else if (parts[0] === 'schedules') {
			recordId = candidate.schedules[Number(parts[1])]?.id;
			if (parts[2] === 'title_template') field = 'title_template';
			if (parts[2] === 'description_template') field = 'description_template';
		}
		if (!recordId || !field) return null;
		const key = `${recordId}:${field}`;
		return editableFields.find((item) => item.key === key) ?? null;
	}
	async function validate(expectedGeneration = candidateGeneration) {
		if (candidateUpdating) {
			status = 'Wait for the candidate edit to finish before validating.';
			return null;
		}
		const snapshot = canonicalizeLibraryValue(candidate);
		busy = true;
		try {
			const result = await api.validateLibrary({
				document_json: snapshot
			});
			if (
				candidateGeneration !== expectedGeneration ||
				canonicalizeLibraryValue(candidate) !== snapshot
			) {
				status =
					'The candidate or its review changed during validation. The older result was discarded.';
				return null;
			}
			diagnostics = result.diagnostics;
			validatedDigest = result.valid ? result.digest : null;
			status = result.valid ? 'File is ready to download.' : 'Some fields need attention.';
			if (!result.valid) {
				await tick();
				diagnosticsPanel?.focus();
			}
			return result;
		} catch (error) {
			status = message(error);
			return null;
		} finally {
			busy = false;
		}
	}
	async function download() {
		if (!reviewComplete) {
			status = 'Review every required skill and repository declaration before downloading.';
			return;
		}
		const expectedGeneration = candidateGeneration;
		const snapshot = canonicalizeLibraryValue(candidate);
		const result = await validate(expectedGeneration);
		if (!result?.valid || !result.document || result.document.profile !== 'workflow') return;
		if (
			candidateGeneration !== expectedGeneration ||
			!reviewComplete ||
			canonicalizeLibraryValue(candidate) !== snapshot
		) {
			status =
				'The candidate or its required review changed during validation. Review it again before downloading.';
			return;
		}
		candidate = result.document;
		const bytes = `${canonicalizeLibraryValue(result.document)}\n`;
		const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' }));
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = `${
			data.workflow.name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '') || 'workflow'
		}.tines.json`;
		anchor.click();
		URL.revokeObjectURL(url);
		status = 'File downloaded.';
	}
	async function focusInput(id: string, trigger: HTMLElement) {
		tokenInvoker = trigger;
		selectedInputId = id;
		await tick();
		inputPanel?.focus();
		inputPanel?.scrollIntoView({ block: 'center' });
	}
	function backToToken() {
		tokenInvoker?.focus();
		tokenInvoker = null;
	}
	async function beginEdit(recordId: string, field: string) {
		selectedTarget = `${recordId}:${field}`;
		fieldEditPending = false;
		await tick();
		fieldEditor?.focus();
	}
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape' && tokenInvoker) backToToken();
	}}
/>

<svelte:head><title>Share {data.workflow.name} · Tines</title></svelte:head>

<a
	href="/workflows/{data.workflow.id}"
	class="text-muted-foreground hover:text-foreground mb-4 inline-flex min-h-10 items-center gap-1 text-sm"
	><IconArrowLeft size={16} /> {data.workflow.name}</a
>
<div class="mb-6 flex flex-wrap items-start justify-between gap-4">
	<div>
		<h1 class="text-2xl font-semibold tracking-tight">Share {data.workflow.name}</h1>
		<p class="text-muted-foreground mt-1 max-w-2xl text-sm">
			Create a reusable copy for others. Review it before making it public.
		</p>
	</div>
</div>

<ol class="mb-6 grid grid-cols-3 gap-2 text-sm" aria-label="Sharing progress">
	{#each ['customize', 'preview', 'share'] as item, index}
		<li
			class="rounded-md border px-3 py-2 capitalize {step === item
				? 'border-primary bg-primary/10 font-medium'
				: 'text-muted-foreground'}"
			aria-current={step === item ? 'step' : undefined}
		>
			{index + 1}. {item}
		</li>
	{/each}
</ol>

{#if step === 'customize'}
	<section class="mb-6 rounded-lg border p-4" aria-labelledby="customize-title">
		<h2 id="customize-title" class="font-semibold" tabindex="-1" bind:this={stepHeading}>
			Customize
		</h2>
		<p class="text-muted-foreground mt-1 text-sm">
			Ready to customize · {candidate.workflows.length} workflow{candidate.workflows.length === 1
				? ''
				: 's'}, {candidate.context.length} included instruction{candidate.context.length === 1
				? ''
				: 's'}.
		</p>
		<label class="mt-4 block max-w-md text-sm">
			Public display name
			<Input
				class="mt-1"
				bind:ref={displayNameInput}
				value={displayName}
				oninput={displayNameChanged}
				maxlength={100}
				autocomplete="name"
				aria-invalid={Boolean(displayNameError)}
				aria-describedby="display-name-help"
			/>
		</label>
		<p id="display-name-help" class="text-muted-foreground mt-1 text-xs">
			Shown publicly with the workflow. Use a name, not an email address.
		</p>
		{#if displayNameError}<p class="text-destructive mt-1 text-sm" role="alert">
				{displayNameError}
			</p>{/if}
	</section>

	<section class="mb-6 rounded-lg border p-4" aria-labelledby="passage-review-title">
		<h2 id="passage-review-title" class="font-semibold">Review and customize passages</h2>
		<p class="text-muted-foreground mt-1 mb-4 text-xs">
			Edit beside the passage, select exact text, then make or reuse a variable. Preview values
			never change the reusable file.
		</p>
		<PackageReview
			document={candidate}
			{reviewed}
			onReview={setReviewed}
			onToken={focusInput}
			expandedFields={diagnosticFieldKeys}
			contextFirst
			{samples}
			{changedInputIds}
			onSaveText={saveInlineText}
			onCreate={createInlineVariable}
			onEditVariable={editInlineVariable}
			onSample={setSample}
		/>
	</section>

	<details class="mb-6 rounded-lg border p-4">
		<summary class="min-h-10 cursor-pointer font-semibold">Add automation (optional)</summary>

		<section class="mb-6 rounded-lg border p-4" aria-labelledby="selection-title">
			<h2 id="selection-title" class="font-semibold">Automation choices</h2>
			<p class="text-muted-foreground mt-1 text-xs">
				None is the default. Choose a source project before selecting its schedules or
				project-scoped routing. Rebuild discards candidate-only edits after confirmation.
			</p>
			<div class="mt-4 grid gap-4 md:grid-cols-2">
				<label class="text-sm"
					>Source project<Select
						class="mt-1"
						bind:value={sourceProjectId}
						onchange={() => {
							selectedSchedules = [];
							if (!sourceProjectId) projectScoped = {};
						}}
						><option value="">None — workflow only</option>{#each data.projects as project}<option
								value={project.id}>{project.name}</option
							>{/each}</Select
					></label
				>
				<div>
					<span class="text-sm">Schedules</span
					>{#if sourceProjectId && availableSchedules.length}{#each availableSchedules as schedule}<label
								class="mt-2 block min-w-0 rounded-md border p-3 text-xs"
								><span class="flex min-h-10 items-center gap-2 text-sm font-medium"
									><input
										type="checkbox"
										checked={selectedSchedules.includes(schedule.id)}
										onchange={(event) => scheduleChanged(schedule.id, event.currentTarget.checked)}
									/>
									{schedule.name}</span
								>
								<dl class="grid grid-cols-[6rem_minmax(0,1fr)] gap-1 pl-6 break-words">
									<dt>Workflow</dt>
									<dd>{schedule.workflow_name}</dd>
									<dt>Start state</dt>
									<dd>
										{schedule.state_id
											? `Explicit: ${schedule.state_name}`
											: 'Follow workflow initial state'}
									</dd>
									<dt>Recurrence</dt>
									<dd>{schedule.preset ? JSON.stringify(schedule.preset) : schedule.cron}</dd>
									<dt>Timezone</dt>
									<dd>{schedule.timezone}</dd>
									<dt>Gate</dt>
									<dd>
										{schedule.require_all_closed
											? 'Require all prior scheduled issues closed'
											: 'No prior-issue closure gate'}
									</dd>
									<dt>Title</dt>
									<dd class="whitespace-pre-wrap">{schedule.title_template}</dd>
									<dt>Description</dt>
									<dd class="whitespace-pre-wrap">{schedule.description_template}</dd>
								</dl></label
							>{/each}{:else}<p class="text-muted-foreground mt-2 text-xs">
							{sourceProjectId
								? 'No schedules belong to a bundled workflow in this project.'
								: 'Select a project to review eligible schedules.'}
						</p>{/if}
				</div>
			</div>
			<details class="mt-4">
				<summary class="min-h-10 cursor-pointer text-sm font-medium"
					>Routing preferences (optional)</summary
				>
				<div class="space-y-3 pt-2">
					{#each data.sourceStates as state}<div
							class="bg-muted/30 grid items-center gap-2 rounded-md p-2 text-xs md:grid-cols-[1fr_10rem_12rem]"
						>
							<span>{state.workflow_name} › {state.name}</span><Select
								bind:value={tierSelections[state.id]}
								><option value="">Do not include</option><option value="smartest">Smartest</option
								><option value="balanced">Balanced</option><option value="cheapest">Cheapest</option
								></Select
							><label class="flex min-h-10 items-center gap-2"
								><input
									type="checkbox"
									bind:checked={projectScoped[state.id]}
									disabled={!sourceProjectId || !tierSelections[state.id]}
								/> Project-scoped</label
							>
						</div>{/each}
				</div>
			</details>
			<Button
				class="mt-4"
				variant="outline"
				onclick={rebuild}
				disabled={busy || candidateUpdating || Boolean(editingInputId)}
				title={editingInputId ? 'Save or cancel the input edit before rebuilding.' : undefined}
				><IconRefresh size={16} /> Apply automation</Button
			>
		</section>
	</details>

	<details class="mb-6 rounded-lg border p-4">
		<summary class="min-h-10 cursor-pointer font-semibold"
			>Customize instructions and variables (optional)</summary
		>
		<section
			class="mb-6 rounded-lg border p-4"
			bind:this={inputPanel}
			tabindex="-1"
			aria-labelledby="inputs-title"
		>
			<div class="flex flex-wrap items-center justify-between gap-2">
				<div>
					<h2 id="inputs-title" class="font-semibold">Variables and places used</h2>
					<p class="text-muted-foreground mt-1 text-xs">
						Changes apply only to this reusable copy. Preview saves the exact draft for sharing.
					</p>
				</div>
				{#if tokenInvoker}<Button size="sm" variant="outline" onclick={backToToken}
						>Back to passage</Button
					>{/if}
			</div>
			{#if editingInputId}
				<h3 class="mt-4 text-sm font-semibold">Editing input {editingInputKey}</h3>
				<p class="text-muted-foreground mt-1 text-xs">
					Key and default changes update this input’s registered tokens. Save resets required
					reviews.
				</p>
			{/if}
			<div class:mt-4={!editingInputId} class="grid gap-3 md:grid-cols-3">
				<label class="text-xs"
					>Key<Input
						id="input-editor-key"
						class="mt-1"
						bind:ref={keyEditor}
						bind:value={draftKey}
						maxlength={64}
						placeholder="bug_label"
					/></label
				><label class="text-xs"
					>Type<Select class="mt-1" bind:value={draftType}
						><option value="text">Text</option><option value="workflow">Workflow</option><option
							value="label">Label</option
						><option value="project">Project</option></Select
					></label
				><label class="text-xs"
					>Default<Input
						id="input-editor-default"
						class="mt-1"
						bind:value={draftDefault}
						maxlength={10000}
						placeholder="No default"
					/></label
				><label class="text-xs"
					>Label<Input
						id="input-editor-label"
						class="mt-1"
						bind:value={draftLabel}
						maxlength={200}
					/></label
				><label class="text-xs md:col-span-2"
					>Description<Input
						id="input-editor-description"
						class="mt-1"
						bind:value={draftDescription}
						maxlength={1000}
					/></label
				>
			</div>
			<label class="mt-2 flex min-h-10 items-center gap-2 text-sm"
				><input type="checkbox" bind:checked={draftRequired} /> Required</label
			>{#if inputFormError}<p class="text-destructive mb-2 text-sm" role="alert">
					{inputFormError}
				</p>{/if}
			{#if editingInputId}
				<div class="flex flex-wrap gap-2">
					<Button class="min-h-10" size="sm" onclick={saveInputEdit} disabled={candidateUpdating}
						>Save changes</Button
					>
					<Button
						class="min-h-10"
						size="sm"
						variant="outline"
						onclick={cancelInputEdit}
						disabled={candidateUpdating}>Cancel</Button
					>
				</div>
			{:else}
				<Button size="sm" variant="outline" onclick={addInput} disabled={candidateUpdating}
					>Add variable</Button
				>
			{/if}
			{#if candidate.inputs.length}<div class="mt-4 grid gap-2 sm:grid-cols-2">
					{#each candidate.inputs as input}
						{@const selected = selectedInput?.id === input.id}
						<div class="flex min-w-0 items-stretch gap-2 rounded-md">
							<button
								id="input-{input.id}"
								type="button"
								aria-pressed={selected}
								class="text-foreground focus-visible:ring-ring focus-visible:ring-offset-background min-h-10 min-w-0 flex-1 rounded-md border p-2 text-left text-xs [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none {selected
									? 'border-primary bg-primary/10'
									: 'border-border bg-transparent'}"
								onclick={() => (selectedInputId = input.id)}
								><b><code class="[overflow-wrap:anywhere]">{input.key}</code> · {input.type}</b><br
								/>{input.label} · {input.required ? 'required' : 'optional'} · default {input.default ??
									'none'}
								<span class="text-primary mt-1 flex min-h-4 items-center gap-1 font-medium">
									{#if selected}<IconCheck
											size={14}
											stroke={2.5}
											class="shrink-0"
											aria-hidden="true"
										/>Selected{/if}
								</span></button
							>
							{#if input.id.startsWith('input:author:')}
								<Button
									id="edit-{input.id}"
									class="size-10 self-center"
									size="icon"
									variant="outline"
									onclick={() => editInput(input)}
									disabled={busy || candidateUpdating || Boolean(editingInputId)}
									title={`Edit input ${input.key}`}
									aria-label={`Edit input ${input.key}`}
									><IconPencil size={16} stroke={1.5} /></Button
								>
							{/if}
						</div>
					{/each}
				</div>{/if}
			<div class="mt-4 border-t pt-4">
				<label class="text-xs"
					>Edit instructions<Select
						class="mt-1"
						bind:value={selectedTarget}
						onchange={() => (fieldEditPending = false)}
						><option value="">Choose a text field</option>{#each editableFields as field}<option
								value={field.key}>{field.label}</option
							>{/each}</Select
					></label
				>{#if selectedField}<Textarea
						class="mt-2 min-h-40 font-mono text-xs"
						bind:ref={fieldEditor}
						value={selectedField.value}
						oninput={(event) =>
							(fieldEditPending = event.currentTarget.value !== selectedField?.value)}
					></Textarea>
					<div class="mt-2 flex flex-wrap gap-2">
						<Button
							size="sm"
							variant="outline"
							onclick={() => saveCandidateField(false)}
							disabled={candidateUpdating}>Save candidate text</Button
						>
						<Button
							size="sm"
							variant="outline"
							onclick={cancelCandidateField}
							disabled={candidateUpdating || !fieldEditPending}>Cancel text edit</Button
						>
						<div
							class="flex max-w-full min-w-0 flex-wrap items-center gap-2"
							data-testid="input-replacement"
						>
							<Button
								size="sm"
								onclick={() => saveCandidateField(true)}
								disabled={!selectedInput || candidateUpdating}>Use selected variable here</Button
							>
							{#if selectedInput}<span
									class="text-muted-foreground max-w-full min-w-0 text-xs [overflow-wrap:anywhere]"
									>Using <code class="[overflow-wrap:anywhere]">{selectedInput.key}</code></span
								>{/if}
						</div>
						<a
							class="text-primary inline-flex min-h-9 items-center px-2 text-xs underline"
							href="/workflows/{data.workflow.id}"
							title="Rebuilding afterward discards this candidate">Edit private source instead</a
						>
					</div>
					<p class="text-muted-foreground mt-2 text-xs">
						This opens the normal source editor. Rebuild afterward to include source changes;
						rebuilding discards this candidate and its draft inputs.
					</p>{/if}
			</div>
		</section>
	</details>

	<div
		class="bg-muted/30 mb-6 min-w-0 rounded-lg border p-4 text-sm break-words"
		role="status"
		aria-live="polite"
	>
		<b>{dirty ? 'Changes applied' : 'Ready to customize'}</b><br /><span
			class="text-muted-foreground"
			>Excluded: project/global/label/issue context, journals, artifacts, history, credentials,
			runner IDs, live schedule state and source database IDs.</span
		>{#if status}<p class="mt-2">{status}</p>{/if}
	</div>
	{#if diagnostics.length}<div
			class="border-destructive/40 bg-destructive/5 text-destructive mb-6 rounded-lg border p-4"
			role="alert"
			tabindex="-1"
			bind:this={diagnosticsPanel}
		>
			<h2 class="font-semibold">Fields to fix</h2>
			<ul class="mt-2 list-disc pl-5 text-sm">
				{#each diagnostics as diagnostic}
					{@const repair = diagnosticField(diagnostic.path)}
					{@const inputRepair = diagnosticInput(diagnostic.path)}
					<li>
						{diagnostic.message}
						{#if repair}<button
								type="button"
								class="ml-2 underline underline-offset-2"
								onclick={() => beginEdit(repair.recordId, repair.field)}
								>Repair {repair.label}</button
							>{/if}
						{#if inputRepair}<button
								type="button"
								class="ml-2 underline underline-offset-2"
								onclick={() => beginInputRepair(inputRepair.input, inputRepair.field)}
								>Repair {inputRepair.label}</button
							>{/if}
					</li>
				{/each}
			</ul>
		</div>{/if}

	<details class="mb-24 rounded-lg border p-4" open={page.url.searchParams.has('download')}>
		<summary class="min-h-10 cursor-pointer font-semibold">Download a file</summary>
		<p class="text-muted-foreground mb-4 text-sm">
			Review included content, then download a private file.
		</p>
		<div class="mt-4 flex flex-wrap gap-2">
			<Button variant="outline" onclick={() => validate()} disabled={busy || candidateUpdating}
				>Check file</Button
			>
			<Button onclick={download} disabled={busy || candidateUpdating || !reviewComplete}
				><IconDownload size={16} /> Download file</Button
			>
		</div>
	</details>
{:else if step === 'preview' && publicationProof}
	<section class="mb-6" aria-labelledby="preview-title">
		<h2
			id="preview-title"
			class="scroll-mt-20 text-xl font-semibold"
			tabindex="-1"
			bind:this={stepHeading}
		>
			Preview
		</h2>
		<p class="text-muted-foreground mt-1 text-sm">This is what people will receive.</p>
		<p class="mt-2 text-sm">Published by {publicationProof.metadata.display_name} · MIT</p>
		{#if proofRequiredReviews.length}<a
				class="text-primary mt-4 inline-flex min-h-10 items-center underline"
				href="#review-{proofRequiredReviews[0].id}"
				onclick={(event) => focusIncludedReview(proofRequiredReviews[0].id, event)}
				>Review {proofRequiredReviews.length} included {proofRequiredReviews.length === 1 &&
				proofRequiredReviews[0].kind === 'skill'
					? 'skill'
					: 'item'}</a
			>{/if}
		<div class="mt-6">
			<PackageReview
				document={publicationProof.document}
				reviewed={new Set()}
				reviewMode="summary"
				contextFirst
			/>
		</div>
		<TechnicalDetails
			items={[
				{ label: 'Candidate', value: publicationProof.candidate_id },
				{ label: 'Review fingerprint', value: publicationProof.review_digest },
				{ label: 'Document fingerprint', value: publicationProof.document_digest },
				{ label: 'Size', value: `${publicationProof.byte_length.toLocaleString()} bytes` },
				{ label: 'Expires', value: new Date(publicationProof.expires_at).toLocaleString() }
			]}
		/>
	</section>
{:else if step === 'share' && publicationProof}
	<section class="mb-24 rounded-lg border p-4" aria-labelledby="share-title">
		<h2
			id="share-title"
			class="scroll-mt-20 text-xl font-semibold"
			tabindex="-1"
			bind:this={stepHeading}
		>
			Ready to share
		</h2>
		<p class="mt-2 font-medium">{proofWorkflowName}</p>
		<p class="text-muted-foreground text-sm">
			Published by {publicationProof.metadata.display_name}
		</p>
		<ol class="mt-4 list-decimal space-y-3 pl-5 text-sm">
			<li>Anyone can view, download and install this shared workflow without your permission.</li>
			<li>
				MIT allows people to use, change and share it, including commercially, while keeping the
				copyright and license notice.
			</li>
			<li>
				This shared version will not change. Removing public access later cannot remove copies
				people already downloaded or installed.
			</li>
		</ol>
		<label class="mt-5 flex min-h-11 items-start gap-3 text-sm"
			><input class="mt-1" type="checkbox" checked={shareConsent} onchange={consentChanged} /> I have
			the right to share all included content, have reviewed this version, and agree to make it public
			under the MIT license.</label
		>
		<button
			type="button"
			class="text-primary mt-3 min-h-10 underline"
			onclick={() => goTo('preview')}>Review included content again</button
		>
	</section>
{:else if step === 'complete' && publicationResult}
	<section
		class="border-primary/40 bg-primary/5 rounded-lg border p-5"
		aria-labelledby="shared-title"
	>
		<h2 id="shared-title" class="text-xl font-semibold" tabindex="-1" bind:this={stepHeading}>
			Shared
		</h2>
		<p class="text-muted-foreground mt-1 text-sm">Your workflow is public and ready to install.</p>
		<a
			class="text-primary mt-4 block break-all underline"
			href={publicationResult.receipt.public_url}>{publicationResult.receipt.public_url}</a
		>
		<a class="text-primary mt-3 inline-flex min-h-10 items-center underline" href="/publications"
			>Manage sharing</a
		>
		<TechnicalDetails
			items={[{ label: 'Receipt', value: publicationResult.receipt.snapshot_id }]}
		/>
	</section>
{/if}

{#if step !== 'complete'}<div
		class="bg-background/95 sticky bottom-[calc(4.75rem+1px+env(safe-area-inset-bottom,0px))] mt-8 flex flex-col items-stretch gap-2 rounded-lg border px-2 py-1 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between md:bottom-3 md:gap-3 md:p-3"
		data-testid="package-actions"
	>
		<p class="min-w-0 text-xs" role="status" aria-live="polite">
			{status ||
				(step === 'customize'
					? 'Ready to customize'
					: step === 'preview'
						? 'Review included content'
						: 'Ready to share')}
		</p>
		<div class="flex min-w-0 flex-col gap-2 sm:flex-row">
			{#if step === 'customize'}<Button
					onclick={prepareForPublication}
					disabled={busy || candidateUpdating || !data.publication.enabled}
					>{busy ? 'Checking…' : 'Preview'}</Button
				>
			{:else if step === 'preview'}<Button
					class="w-full sm:w-auto"
					variant="outline"
					onclick={() => goTo('customize')}>Back to Customize</Button
				><Button
					class="h-auto min-h-9 w-full whitespace-normal sm:w-auto"
					onclick={reviewIncludedAndShare}
					>{requiredReviews.length === 1
						? 'I reviewed the included skill — Continue to Share'
						: requiredReviews.length
							? 'I reviewed the included items — Continue to Share'
							: 'Continue to Share'}</Button
				>
			{:else}<Button variant="outline" onclick={() => goTo('preview')}>Back to Preview</Button
				><Button onclick={publish} disabled={busy || !shareConsent}
					>{busy ? 'Publishing…' : 'Publish workflow'}</Button
				>{/if}
		</div>
	</div>
	{#if step === 'customize' && !data.publication.enabled}<p
			class="text-muted-foreground mt-2 text-right text-xs"
		>
			Public sharing is unavailable on this host. Download a file is still available.
		</p>{/if}{/if}
