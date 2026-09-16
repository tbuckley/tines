<script lang="ts">
	import type { PackageInput, TextUseField } from '@tines/shared';
	import IconEye from '@tabler/icons-svelte/icons/eye';
	import IconPencil from '@tabler/icons-svelte/icons/pencil';
	import IconVariable from '@tabler/icons-svelte/icons/variable';
	import { tick } from 'svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { generateInputKey, type InputDraft } from './package-input-editor';
	import PackageText, { type PackageTextToken } from './PackageText.svelte';

	let {
		recordId,
		field,
		label,
		text,
		format = 'text',
		tokens = [],
		inputs,
		samples = {},
		onToken,
		onSaveText,
		onCreate,
		onEditVariable,
		onSample,
		forceExpanded = false
	}: {
		recordId: string;
		field: TextUseField;
		label: string;
		text: string;
		format?: 'markdown' | 'text';
		tokens?: PackageTextToken[];
		inputs: PackageInput[];
		samples?: Record<string, string>;
		onToken?: (id: string, trigger: HTMLElement) => void;
		onSaveText?: (recordId: string, field: TextUseField, value: string) => Promise<boolean>;
		onCreate?: (request: {
			recordId: string;
			field: TextUseField;
			sourceSnapshot: string;
			value: string;
			start: number;
			end: number;
			direction: 'forward' | 'backward' | 'none';
			inputId?: string;
			draft?: InputDraft;
		}) => Promise<string | null>;
		onSample?: (inputId: string, value: string | undefined) => void;
		onEditVariable?: (inputId: string, draft: InputDraft) => Promise<boolean>;
		forceExpanded?: boolean;
	} = $props();

	const scope = $derived(
		`package-field-${recordId.replace(/[^a-zA-Z0-9_-]/g, '-')}-${field.replace(/_/g, '-')}`
	);
	let mode = $state<'preview' | 'edit'>('preview');
	let draftValue = $state('');
	let baseValue = $state('');
	let lastText = $state('');
	let start = $state(0);
	let end = $state(0);
	let direction = $state<'forward' | 'backward' | 'none'>('none');
	let editor = $state<HTMLTextAreaElement | null>(null);
	let creating = $state(false);
	let choice = $state('new');
	let friendlyName = $state('');
	let internalKey = $state('');
	let defaultValue = $state('');
	let type = $state<PackageInput['type']>('text');
	let required = $state(true);
	let description = $state('');
	let keyOverridden = $state(false);
	let formError = $state('');
	let friendlyInput = $state<HTMLInputElement | null>(null);
	let previewValuesOpen = $state(false);
	let editingInputId = $state<string | null>(null);
	let occurrenceTrigger = $state<HTMLElement | null>(null);
	const usedInputs = $derived(
		[...new Set(tokens.map((token) => token.inputId))]
			.map((id) => inputs.find((input) => input.id === id))
			.filter((input): input is PackageInput => Boolean(input))
	);

	$effect(() => {
		if (text === lastText) return;
		if (draftValue === lastText || (mode === 'preview' && !creating)) draftValue = text;
		baseValue = text;
		lastText = text;
	});
	$effect(() => {
		if (!keyOverridden)
			internalKey = generateInputKey(
				friendlyName,
				inputs.map((input) => input.key)
			);
	});

	function captureSelection() {
		if (!editor) return;
		start = editor.selectionStart;
		end = editor.selectionEnd;
		direction = editor.selectionDirection;
	}
	async function edit() {
		mode = 'edit';
		await tick();
		editor?.focus();
		editor?.setSelectionRange(start, end, direction);
	}
	async function preview() {
		captureSelection();
		mode = 'preview';
	}
	async function beginCreate() {
		captureSelection();
		if (start === end) {
			formError = 'Select text in this passage first.';
			return;
		}
		creating = true;
		editingInputId = null;
		choice = 'new';
		friendlyName = '';
		defaultValue = draftValue.slice(start, end);
		type = 'text';
		required = true;
		description = '';
		keyOverridden = false;
		formError = '';
		await tick();
		friendlyInput?.focus();
	}
	async function cancelCreate() {
		creating = false;
		formError = '';
		await tick();
		if (editingInputId) occurrenceTrigger?.focus();
		else {
			editor?.focus();
			editor?.setSelectionRange(start, end, direction);
		}
		editingInputId = null;
		occurrenceTrigger = null;
	}
	async function editVariable(inputId: string, trigger: HTMLElement) {
		const input = inputs.find((item) => item.id === inputId);
		if (!input?.id.startsWith('input:author:')) {
			onToken?.(inputId, trigger);
			return;
		}
		editingInputId = inputId;
		occurrenceTrigger = trigger;
		creating = true;
		friendlyName = input.label;
		internalKey = input.key;
		defaultValue = input.default ?? '';
		type = input.type;
		required = input.required;
		description = input.description;
		keyOverridden = true;
		formError = '';
		await tick();
		friendlyInput?.focus();
	}
	async function saveVariable() {
		if (!onCreate && !onEditVariable) return;
		formError = '';
		if ((choice === 'new' || editingInputId) && !friendlyName.trim()) {
			formError = 'Enter a friendly name.';
			friendlyInput?.focus();
			return;
		}
		const variableDraft: InputDraft = {
			key: internalKey,
			type,
			label: friendlyName,
			description,
			default: defaultValue,
			required
		};
		if (editingInputId) {
			const inputId = editingInputId;
			if (!(await onEditVariable?.(inputId, variableDraft))) {
				formError = 'The variable could not be saved. Review the status below the passages.';
				return;
			}
			creating = false;
			editingInputId = null;
			await tick();
			draftValue = text;
			baseValue = text;
			lastText = text;
			await tick();
			document
				.querySelector<HTMLElement>(
					`#${CSS.escape(scope)} [data-input-id="${CSS.escape(inputId)}"]`
				)
				?.focus();
			return;
		}
		const inputId = await onCreate?.({
			recordId,
			field,
			sourceSnapshot: baseValue,
			value: draftValue,
			start,
			end,
			direction,
			...(choice === 'new'
				? {
						draft: variableDraft
					}
				: { inputId: choice })
		});
		if (!inputId) return;
		creating = false;
		mode = 'preview';
		await tick();
		draftValue = text;
		baseValue = text;
		lastText = text;
		await tick();
		document
			.querySelector<HTMLElement>(`#${CSS.escape(scope)} [data-input-id="${CSS.escape(inputId)}"]`)
			?.focus();
	}
	async function saveText() {
		if (!(await onSaveText?.(recordId, field, draftValue))) return;
		baseValue = draftValue;
		mode = 'preview';
	}
	function cancelText() {
		draftValue = text;
		baseValue = text;
		creating = false;
		mode = 'preview';
	}
</script>

<section id={scope} class="mt-2 min-w-0 rounded-md border p-3" aria-label={label}>
	<div class="mb-2 flex flex-wrap items-center justify-between gap-2">
		<span class="text-muted-foreground text-xs font-medium">{label}</span>
		<div class="flex gap-1" aria-label={`${label} mode`}>
			<Button size="sm" variant={mode === 'edit' ? 'secondary' : 'ghost'} onclick={edit}
				><IconPencil size={15} /> Edit</Button
			>
			<Button size="sm" variant={mode === 'preview' ? 'secondary' : 'ghost'} onclick={preview}
				><IconEye size={15} /> Preview</Button
			>
		</div>
	</div>
	{#if mode === 'preview'}
		<PackageText
			text={draftValue}
			{format}
			{tokens}
			onToken={editVariable}
			{forceExpanded}
			occurrenceScope={scope}
		/>
		{#if draftValue !== text}<p class="text-muted-foreground mt-2 text-xs">Unsaved text</p>{/if}
	{:else}
		<label class="sr-only" for={`${scope}-editor`}>{label}</label>
		<Textarea
			id={`${scope}-editor`}
			class="min-h-32 font-mono text-xs"
			bind:ref={editor}
			bind:value={draftValue}
			onselect={captureSelection}
			onkeyup={captureSelection}
			onpointerup={captureSelection}
			oninput={captureSelection}
		/>
		<p class="text-muted-foreground mt-1 text-xs" aria-live="polite">
			{start === end
				? 'Select text in this passage first.'
				: `Selected: ${draftValue.slice(start, end)} · ${end - start} characters`}
		</p>
		<div class="mt-2 flex flex-wrap gap-2">
			<Button size="sm" onclick={beginCreate} aria-disabled={start === end}
				><IconVariable size={16} /> Make variable</Button
			>
			<Button size="sm" variant="outline" onclick={saveText} disabled={draftValue === text}
				>Save text</Button
			>
			<Button size="sm" variant="ghost" onclick={cancelText} disabled={draftValue === text}
				>Cancel text edits</Button
			>
		</div>
	{/if}

	{#if creating}
		<div class="bg-muted/30 mt-3 rounded-md border p-3" aria-label="Make variable">
			<p class="text-muted-foreground mb-3 text-xs break-words">
				{#if editingInputId}Edit this variable beside its passage.{:else}Selected: <q
						>{draftValue.slice(start, end)}</q
					>{/if}
			</p>
			{#if !editingInputId}<label class="text-xs"
					>Variable<Select class="mt-1" bind:value={choice}>
						<option value="new">New variable</option>
						{#each inputs as input}<option value={input.id}
								>{input.label} · {input.key} · {input.type}</option
							>{/each}
					</Select></label
				>{/if}
			{#if choice === 'new' || editingInputId}
				<label class="mt-3 block text-xs"
					>Friendly name<Input
						class="mt-1"
						bind:ref={friendlyInput}
						bind:value={friendlyName}
						maxlength={200}
					/></label
				>
				<details class="mt-3">
					<summary class="min-h-10 cursor-pointer text-xs font-medium">More options</summary>
					<div class="grid gap-3 pt-2 sm:grid-cols-2">
						<label class="text-xs"
							>Example/default<Input
								class="mt-1"
								bind:value={defaultValue}
								maxlength={10000}
							/></label
						>
						<label class="text-xs"
							>Internal key<Input
								class="mt-1"
								value={internalKey}
								oninput={(event) => {
									keyOverridden = true;
									internalKey = event.currentTarget.value;
								}}
								maxlength={64}
							/></label
						>
						<label class="text-xs"
							>Type<Select class="mt-1" bind:value={type}
								><option value="text">Text</option><option value="workflow">Workflow</option><option
									value="label">Label</option
								><option value="project">Project</option></Select
							></label
						>
						<label class="flex min-h-11 items-center gap-2 text-xs"
							><input type="checkbox" bind:checked={required} /> Required</label
						>
						<label class="text-xs sm:col-span-2"
							>Description<Input class="mt-1" bind:value={description} maxlength={1000} /></label
						>
					</div>
				</details>
			{:else}
				{@const existing = inputs.find((input) => input.id === choice)}
				<p class="text-muted-foreground mt-2 text-xs">
					Uses {existing?.default ?? 'no default'} without changing its declaration.
				</p>
			{/if}
			{#if formError}<p class="text-destructive mt-2 text-sm" role="alert">{formError}</p>{/if}
			<div class="mt-3 flex gap-2">
				<Button size="sm" onclick={saveVariable}>{editingInputId ? 'Done' : 'Save'}</Button><Button
					size="sm"
					variant="outline"
					onclick={cancelCreate}>Cancel</Button
				>
			</div>
		</div>
	{/if}

	{#if usedInputs.length && mode === 'preview'}
		<div class="mt-2">
			<Button
				size="sm"
				variant="ghost"
				onclick={() => (previewValuesOpen = !previewValuesOpen)}
				aria-expanded={previewValuesOpen}>Preview values</Button
			>
			{#if previewValuesOpen}<div class="mt-2 grid gap-3 sm:grid-cols-2">
					{#each usedInputs as input}<label class="text-xs"
							>Sample value — {input.label}<Input
								class="mt-1"
								value={Object.hasOwn(samples, input.id) ? samples[input.id] : (input.default ?? '')}
								oninput={(event) => onSample?.(input.id, event.currentTarget.value)}
								maxlength={10000}
							/><span class="text-muted-foreground"
								>Only changes this preview.{input.default === null ? ' No default.' : ''}</span
							><Button
								class="mt-1"
								size="sm"
								variant="ghost"
								onclick={() => onSample?.(input.id, undefined)}>Use default</Button
							></label
						>{/each}
				</div>{/if}
		</div>
	{/if}
</section>
