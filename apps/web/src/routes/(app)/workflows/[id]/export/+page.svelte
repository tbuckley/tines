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
	import IconCheck from '@tabler/icons-svelte/icons/check';
	import IconDownload from '@tabler/icons-svelte/icons/download';
	import IconRefresh from '@tabler/icons-svelte/icons/refresh';
	import { tick } from 'svelte';
	import { api } from '$lib/api';
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
	let selectedInputId = $state('');
	let selectedTarget = $state('');
	let fieldEditor = $state<HTMLTextAreaElement | null>(null);
	let inputPanel = $state<HTMLElement | null>(null);
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
		const key = draftKey.trim();
		if (
			!/^[a-z][a-z0-9_]{0,63}$/.test(key) ||
			candidate.inputs.some((input) => input.key === key)
		) {
			status = candidate.inputs.some((input) => input.key === key)
				? `Input key “${key}” already exists.`
				: 'Use a lowercase input key beginning with a letter and containing only letters, numbers, or underscores.';
			return;
		}
		candidateGeneration += 1;
		candidateUpdating = true;
		const id = `input:author:${candidate.inputs.length + 1}`;
		const next = {
			...candidate,
			inputs: [
				...candidate.inputs,
				{
					id,
					key,
					type: draftType,
					label: draftLabel.trim() || key,
					description: draftDescription,
					required: draftRequired,
					default: draftDefault === '' ? null : draftDefault
				}
			]
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
	function writeField(
		document: WorkflowPackageDocument,
		recordId: string,
		field: TextUseField,
		value: string
	) {
		for (const workflow of document.workflows)
			if (workflow.id === recordId && field === 'description') workflow.description = value;
		for (const item of document.context) {
			if (item.id === recordId && field === 'description') item.description = value;
			if (item.id === recordId && item.kind === 'prompt' && field === 'body') item.body = value;
			if (item.kind === 'skill')
				for (const file of item.files)
					if (file.id === recordId && field === 'content') file.content = value;
		}
		for (const schedule of document.schedules)
			if (schedule.id === recordId) {
				if (field === 'title_template') schedule.title_template = value;
				if (field === 'description_template') schedule.description_template = value;
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
	<Button class="mt-4" variant="outline" onclick={rebuild} disabled={busy}
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
	<div class="mt-4 grid gap-3 md:grid-cols-3">
		<label class="text-xs"
			>Key<Input class="mt-1" bind:value={draftKey} maxlength={64} placeholder="bug_label" /></label
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
	><Button size="sm" variant="outline" onclick={addInput} disabled={candidateUpdating}
		>Add typed declaration</Button
	>
	{#if candidate.inputs.length}<div class="mt-4 grid gap-2 sm:grid-cols-2">
			{#each candidate.inputs as input}
				{@const selected = selectedInput?.id === input.id}
				<button
					id="input-{input.id}"
					type="button"
					aria-pressed={selected}
					class="text-foreground focus-visible:ring-ring focus-visible:ring-offset-background min-h-10 min-w-0 rounded-md border p-2 text-left text-xs [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none {selected
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
			{/each}
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
				>
				<div
					class="flex max-w-full min-w-0 flex-wrap items-center gap-2"
					data-testid="input-replacement"
				>
					<Button
						size="sm"
						onclick={() => saveCandidateField(true)}
						disabled={!selectedInput || candidateUpdating}
						>Replace selection with declared token</Button
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
	class="bg-background/95 sticky bottom-[calc(4.75rem+1px+env(safe-area-inset-bottom,0px))] mt-8 flex items-center justify-between gap-2 rounded-lg border px-2 py-1 shadow-lg backdrop-blur md:bottom-3 md:gap-3 md:p-3"
	data-testid="package-actions"
>
	<p class="min-w-0 text-xs md:break-all">
		<span class="md:hidden">
			{reviewComplete
				? 'Ready'
				: `${requiredReviews.filter((id) => !reviewed.has(id)).length} left`}
		</span>
		<span class="hidden md:inline">
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
