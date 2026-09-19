<script lang="ts">
	import {
		ARTIFACT_FILE_MAX_BYTES,
		ARTIFACT_NAME_PATTERN,
		ISSUE_CREATE_FILES_MAX_BYTES,
		ISSUE_CREATE_MAX_FILES,
		requirementAccepts,
		suggestArtifactName,
		type WorkflowTransition
	} from '@tines/shared';
	import IconFile from '@tabler/icons-svelte/icons/file';
	import IconPaperclip from '@tabler/icons-svelte/icons/paperclip';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';

	export interface IssueAttachmentDraft {
		id: string;
		file: File;
		name: string;
		editing: boolean;
	}

	let {
		attachments = $bindable([]),
		disabled = false,
		transitions = [],
		onvalidchange
	}: {
		attachments?: IssueAttachmentDraft[];
		disabled?: boolean;
		transitions?: WorkflowTransition[];
		onvalidchange?: (valid: boolean) => void;
	} = $props();

	let input = $state<HTMLInputElement | null>(null);
	let selectionError = $state<string | null>(null);
	const totalBytes = $derived(attachments.reduce((sum, a) => sum + a.file.size, 0));
	const errors = $derived(
		attachments.map((attachment, index) => {
			const name = attachment.name.trim();
			if (!name || name.length > 100 || !ARTIFACT_NAME_PATTERN.test(name))
				return 'Use 1–100 lowercase letters, numbers, or hyphens.';
			if (
				attachments.some((other, otherIndex) => otherIndex !== index && other.name.trim() === name)
			)
				return 'Each attachment name must be unique.';
			return null;
		})
	);
	const valid = $derived(errors.every((error) => error === null));
	$effect(() => onvalidchange?.(valid));

	function displaySize(bytes: number) {
		return bytes < 1024 * 1024
			? `${Math.ceil(bytes / 1024)} KiB`
			: `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
	}

	function add(files: File[]) {
		selectionError = null;
		if (attachments.length + files.length > ISSUE_CREATE_MAX_FILES) {
			selectionError = `Choose at most ${ISSUE_CREATE_MAX_FILES} files.`;
			return;
		}
		const oversized = files.find((file) => file.size > ARTIFACT_FILE_MAX_BYTES);
		if (oversized) {
			selectionError = `${oversized.name} is larger than 25 MiB.`;
			return;
		}
		if (
			totalBytes + files.reduce((sum, file) => sum + file.size, 0) >
			ISSUE_CREATE_FILES_MAX_BYTES
		) {
			selectionError = 'Attachments must total 50 MiB or less.';
			return;
		}
		const used = attachments.map((attachment) => attachment.name);
		const added = files.map((file) => {
			const name = suggestArtifactName(file.name, used);
			used.push(name);
			return { id: crypto.randomUUID(), file, name, editing: false };
		});
		attachments = [...attachments, ...added];
	}

	function picked(event: Event) {
		const target = event.currentTarget as HTMLInputElement;
		add([...(target.files ?? [])]);
		target.value = '';
	}

	function dropped(event: DragEvent) {
		event.preventDefault();
		if (disabled || !event.dataTransfer) return;
		const hasDirectory = [...event.dataTransfer.items].some((item) => {
			const entry = (
				item as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory: boolean } | null }
			).webkitGetAsEntry?.();
			return entry?.isDirectory;
		});
		if (hasDirectory) {
			selectionError = 'Choose files inside the folder.';
			return;
		}
		add([...event.dataTransfer.files]);
	}

	function warning(attachment: IssueAttachmentDraft): string | null {
		const gates = transitions.flatMap((transition) =>
			(transition.requires ?? [])
				.filter((requirement) => requirement.artifact === attachment.name.trim())
				.map((requirement) => ({ transition: transition.name, requirement }))
		);
		if (
			gates.length === 0 ||
			gates.some((gate) =>
				requirementAccepts(
					gate.requirement,
					'file',
					attachment.file.type || 'application/octet-stream'
				)
			)
		)
			return null;
		return `This file won’t satisfy the ${gates[0].transition} requirement for “${attachment.name.trim()}”.`;
	}
</script>

<section class="space-y-2" aria-labelledby="issue-attachments-label">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div>
			<span id="issue-attachments-label" class="text-sm font-medium">Attachments (optional)</span>
			<p class="text-muted-foreground text-xs">Up to 10 files · 25 MiB each · 50 MiB total</p>
		</div>
		<Button type="button" size="sm" variant="outline" {disabled} onclick={() => input?.click()}>
			<IconPaperclip size={15} /> Add files
		</Button>
		<input
			bind:this={input}
			class="sr-only"
			type="file"
			multiple
			onchange={picked}
			{disabled}
			aria-label="Add attachment files"
		/>
	</div>
	<div
		class="border-muted-foreground/40 rounded-md border border-dashed p-3 text-center text-xs"
		role="group"
		aria-label="Attachment drop area"
		ondragover={(event) => event.preventDefault()}
		ondrop={dropped}
	>
		Drop files here
	</div>
	{#if selectionError}<p class="text-destructive text-sm" role="alert">{selectionError}</p>{/if}
	{#if attachments.length > 0}
		<ul class="space-y-2">
			{#each attachments as attachment, index (attachment.id)}
				{@const gateWarning = warning(attachment)}
				<li class="min-w-0 rounded-md border p-3">
					<div class="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start">
						<IconFile class="text-muted-foreground mt-0.5 shrink-0" size={18} />
						<div class="min-w-0 flex-1">
							<p class="text-sm font-medium break-words">{attachment.file.name}</p>
							<p class="text-muted-foreground text-xs">{displaySize(attachment.file.size)}</p>
							{#if attachment.editing}
								<label
									class="mt-2 block text-xs font-medium"
									for={`attachment-name-${attachment.id}`}>Artifact name</label
								>
								<Input
									id={`attachment-name-${attachment.id}`}
									bind:value={attachment.name}
									{disabled}
									aria-invalid={errors[index] ? 'true' : undefined}
									aria-describedby={errors[index] ? `attachment-error-${attachment.id}` : undefined}
								/>
							{:else}
								<p class="mt-1 font-mono text-xs break-words">{attachment.name}</p>
							{/if}
							{#if errors[index]}<p
									id={`attachment-error-${attachment.id}`}
									class="text-destructive text-xs"
								>
									{errors[index]}
								</p>{/if}
							{#if gateWarning}<p class="text-xs text-amber-700 dark:text-amber-400">
									{gateWarning}
								</p>{/if}
						</div>
						<div class="flex shrink-0 gap-1">
							<Button
								type="button"
								size="sm"
								variant="ghost"
								{disabled}
								aria-label={`Edit name for ${attachment.file.name}`}
								onclick={() => (attachment.editing = !attachment.editing)}>Edit name</Button
							>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								{disabled}
								aria-label={`Remove ${attachment.file.name}`}
								onclick={() => (attachments = attachments.filter((_, i) => i !== index))}
								>Remove</Button
							>
						</div>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>
