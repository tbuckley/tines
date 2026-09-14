<script lang="ts">
	import {
		ApiError,
		canonicalizeLibraryValue,
		inputToken,
		withLibraryDocumentDigest,
		type ExportWorkflowPackageOptions,
		type LibraryDiagnostic,
		type ModelTier,
		type PackageInput,
		type TextUseField,
		type WorkflowPackageDocument
	} from '@tines/shared';
	import IconArrowLeft from '@tabler/icons-svelte/icons/arrow-left';
	import IconDownload from '@tabler/icons-svelte/icons/download';
	import IconPencil from '@tabler/icons-svelte/icons/pencil';
	import IconRefresh from '@tabler/icons-svelte/icons/refresh';
	import { tick } from 'svelte';
	import { api } from '$lib/api';
	import {
		normalizeInputDraft,
		updateAuthoredInput,
		writeField,
		type InputDraft
	} from '$lib/components/library/package-input-editor';
	import PackageReview from '$lib/components/library/PackageReview.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';

	let { data } = $props();
	function initialCandidate(): WorkflowPackageDocument {
		return structuredClone(data.candidate);
	}
	let candidate = $state<WorkflowPackageDocument>(initialCandidate());
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
	let inputPanel = $state<HTMLElement | null>(null);
	let keyEditor = $state<HTMLInputElement | null>(null);
	let tokenInvoker = $state<HTMLElement | null>(null);
	let diagnosticsPanel = $state<HTMLElement | null>(null);

	const requiredReviews = $derived(
		candidate.context
			.filter((item) => item.kind === 'skill' || item.kind === 'repo')
			.map((item) => item.id)
	);
	const reviewComplete = $derived(requiredReviews.every((id) => reviewed.has(id)));
	const availableSchedules = $derived(
		data.schedules.filter((schedule) => schedule.project_id === sourceProjectId)
	);
	const editableFields = $derived.by(() => {
		const fields: {
			key: string;
			recordId: string;
			field: TextUseField;
			label: string;
			value: string;
		}[] = [];
		for (const workflow of candidate.workflows)
			fields.push({
				key: `${workflow.id}:description`,
				recordId: workflow.id,
				field: 'description',
				label: `${workflow.name} — description`,
				value: workflow.description
			});
		for (const item of candidate.context) {
			if (item.description)
				fields.push({
					key: `${item.id}:description`,
					recordId: item.id,
					field: 'description',
					label: `${item.name} — description`,
					value: item.description
				});
			if (item.kind === 'prompt')
				fields.push({
					key: `${item.id}:body`,
					recordId: item.id,
					field: 'body',
					label: `${item.name} — prompt body`,
					value: item.body
				});
			if (item.kind === 'skill')
				for (const file of item.files)
					fields.push({
						key: `${file.id}:content`,
						recordId: file.id,
						field: 'content',
						label: `${item.name} / ${file.path}`,
						value: file.content
					});
		}
		for (const schedule of candidate.schedules) {
			fields.push({
				key: `${schedule.id}:title_template`,
				recordId: schedule.id,
				field: 'title_template',
				label: `${schedule.name} — title template`,
				value: schedule.title_template
			});
			fields.push({
				key: `${schedule.id}:description_template`,
				recordId: schedule.id,
				field: 'description_template',
				label: `${schedule.name} — description template`,
				value: schedule.description_template
			});
		}
		return fields;
	});
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
		candidateGeneration += 1;
		reviewed = new Set();
		validatedDigest = null;
		diagnostics = [];
		status = `${note} Required skill and repository review was reset.`;
	}
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
		if (
			dirty &&
			!confirm('Rebuilding from the source discards candidate-only text and input edits. Continue?')
		)
			return;
		busy = true;
		status = 'Rebuilding the candidate from its private source…';
		try {
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
			candidate = await api.exportWorkflowPackage(data.workflow.id, {
				...(sourceProjectId ? { source_project_id: sourceProjectId } : {}),
				schedule_ids: selectedSchedules,
				tiers
			});
			dirty = false;
			if (!candidate.inputs.some((input) => input.id === selectedInputId)) selectedInputId = '';
			resetReview('Candidate rebuilt from source.');
		} catch (error) {
			status = message(error);
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
		candidateGeneration += 1;
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
		candidateGeneration += 1;
		candidateUpdating = true;
		let saved = false;
		try {
			const updated = updateAuthoredInput(snapshot, inputId, inputDraft());
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
		candidateGeneration += 1;
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
			status = result.valid
				? `Validated ${result.digest}.`
				: 'Validation found fields that need attention.';
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
		status = `Downloaded the exact reviewed canonical bytes for ${result.digest}.`;
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
		await tick();
		fieldEditor?.focus();
	}
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape' && tokenInvoker) backToToken();
	}}
/>

<svelte:head><title>Export {data.workflow.name} · Tines</title></svelte:head>

<a
	href="/workflows/{data.workflow.id}"
	class="text-muted-foreground hover:text-foreground mb-4 inline-flex min-h-10 items-center gap-1 text-sm"
	><IconArrowLeft size={16} /> {data.workflow.name}</a
>
<div class="mb-6 flex flex-wrap items-start justify-between gap-4">
	<div>
		<h1 class="text-2xl font-semibold tracking-tight">Export workflow package</h1>
		<p class="text-muted-foreground mt-1 max-w-2xl text-sm">
			Build, inspect, validate and download an independent package. Nothing is installed, published,
			fetched or changed in the source.
		</p>
	</div>
	<Button onclick={download} disabled={busy || candidateUpdating || !reviewComplete}
		><IconDownload size={16} /> Validate & download</Button
	>
</div>

<section class="mb-6 rounded-lg border p-4" aria-labelledby="selection-title">
	<h2 id="selection-title" class="font-semibold">1. Rebuild selections</h2>
	<p class="text-muted-foreground mt-1 text-xs">
		None is the default. Choose a source project before selecting its schedules or project-scoped
		routing. Rebuild discards candidate-only edits after confirmation.
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
			>Tier preferences (explicit, optional)</summary
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
		><IconRefresh size={16} /> Rebuild from source</Button
	>
</section>

<section
	class="mb-6 rounded-lg border p-4"
	bind:this={inputPanel}
	tabindex="-1"
	aria-labelledby="inputs-title"
>
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div>
			<h2 id="inputs-title" class="font-semibold">2. Candidate inputs and exact text uses</h2>
			<p class="text-muted-foreground mt-1 text-xs">
				Declarations and edits affect this candidate only. Values substitute once, only at the exact
				registered token in the selected field.
			</p>
		</div>
		{#if tokenInvoker}<Button size="sm" variant="outline" onclick={backToToken}
				>Back to passage</Button
			>{/if}
	</div>
	{#if editingInputId}
		<h3 class="mt-4 text-sm font-semibold">Editing input {editingInputKey}</h3>
		<p class="text-muted-foreground mt-1 text-xs">
			Key and default changes update this input’s registered tokens. Save resets required reviews.
		</p>
	{/if}
	<div class:mt-4={!editingInputId} class="grid gap-3 md:grid-cols-3">
		<label class="text-xs"
			>Key<Input
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
				class="mt-1"
				bind:value={draftDefault}
				maxlength={10000}
				placeholder="No default"
			/></label
		><label class="text-xs"
			>Label<Input class="mt-1" bind:value={draftLabel} maxlength={200} /></label
		><label class="text-xs md:col-span-2"
			>Description<Input class="mt-1" bind:value={draftDescription} maxlength={1000} /></label
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
			>Add typed declaration</Button
		>
	{/if}
	{#if candidate.inputs.length}<div class="mt-4 grid gap-2 sm:grid-cols-2">
			{#each candidate.inputs as input}<div class="flex min-w-0 items-stretch gap-2 rounded-md">
					<button
						id="input-{input.id}"
						type="button"
						class:selected={selectedInputId === input.id}
						class="min-h-10 min-w-0 flex-1 rounded-md border p-2 text-left text-xs break-words focus-visible:outline-2"
						onclick={() => (selectedInputId = input.id)}
						><b><code>{input.key}</code> · {input.type}</b><br />{input.label} · {input.required
							? 'required'
							: 'optional'} · default {input.default ?? 'none'}</button
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
							aria-label={`Edit input ${input.key}`}><IconPencil size={16} stroke={1.5} /></Button
						>
					{/if}
				</div>{/each}
		</div>{/if}
	<div class="mt-4 border-t pt-4">
		<label class="text-xs"
			>Exact candidate field<Select class="mt-1" bind:value={selectedTarget}
				><option value="">Choose a text field</option>{#each editableFields as field}<option
						value={field.key}>{field.label}</option
					>{/each}</Select
			></label
		>{#if selectedField}<Textarea
				class="mt-2 min-h-40 font-mono text-xs"
				bind:ref={fieldEditor}
				value={selectedField.value}
			></Textarea>
			<div class="mt-2 flex flex-wrap gap-2">
				<Button
					size="sm"
					variant="outline"
					onclick={() => saveCandidateField(false)}
					disabled={candidateUpdating}>Save candidate text</Button
				><Button
					size="sm"
					onclick={() => saveCandidateField(true)}
					disabled={!selectedInput || candidateUpdating}
					>Replace selection with declared token</Button
				><a
					class="text-primary inline-flex min-h-9 items-center px-2 text-xs underline"
					href="/workflows/{data.workflow.id}"
					title="Rebuilding afterward discards this candidate">Edit private source instead</a
				>
			</div>
			<p class="text-muted-foreground mt-2 text-xs">
				This opens the normal source editor. Rebuild afterward to include source changes; rebuilding
				discards this candidate and its draft inputs.
			</p>{/if}
	</div>
</section>

<div
	class="bg-muted/30 mb-6 min-w-0 rounded-lg border p-4 text-sm break-words"
	role="status"
	aria-live="polite"
>
	<b>Candidate:</b>
	<span class="break-all"> {candidate.digest}</span><br /><span class="text-muted-foreground"
		>Excluded: project/global/label/issue context, journals, artifacts, history, credentials, runner
		IDs, live schedule state and source database IDs.</span
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
				<li>
					<code>{diagnostic.path || '/'}</code>: {diagnostic.message}
					{#if repair}<button
							type="button"
							class="ml-2 underline underline-offset-2"
							onclick={() => beginEdit(repair.recordId, repair.field)}>Repair {repair.label}</button
						>{/if}
				</li>
			{/each}
		</ul>
	</div>{/if}

<PackageReview
	document={candidate}
	{reviewed}
	onReview={setReviewed}
	onToken={focusInput}
	onEdit={beginEdit}
	expandedFields={diagnosticFieldKeys}
/>

<div
	class="bg-background/95 sticky bottom-[4.75rem] mt-8 flex items-center justify-between gap-2 rounded-lg border px-2 py-1 shadow-lg backdrop-blur sm:bottom-3 sm:gap-3 sm:p-3"
	data-testid="package-actions"
>
	<p class="min-w-0 text-xs sm:break-all">
		<span class="sm:hidden">
			{reviewComplete
				? 'Ready'
				: `${requiredReviews.filter((id) => !reviewed.has(id)).length} left`}
		</span>
		<span class="hidden sm:inline">
			{reviewComplete
				? 'All required skill and repository declarations reviewed.'
				: `${requiredReviews.filter((id) => !reviewed.has(id)).length} required declaration review(s) remain.`}{#if validatedDigest}<br
				/>Validated {validatedDigest}{/if}
		</span>
	</p>
	<div class="flex gap-2">
		<Button variant="outline" onclick={() => validate()} disabled={busy || candidateUpdating}
			>Validate</Button
		><Button onclick={download} disabled={busy || candidateUpdating || !reviewComplete}
			><IconDownload size={16} /> Download package</Button
		>
	</div>
</div>
