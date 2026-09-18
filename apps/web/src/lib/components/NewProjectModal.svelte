<script lang="ts">
	import type { StarterInputSpec, StarterSummary } from '@tines/shared';
	import { ApiError, PROJECT_NAME_MAX } from '@tines/shared';
	import IconBulb from '@tabler/icons-svelte/icons/bulb';
	import IconFile from '@tabler/icons-svelte/icons/file';
	import IconGitBranch from '@tabler/icons-svelte/icons/git-branch';
	import IconSparkles from '@tabler/icons-svelte/icons/sparkles';
	import { goto, invalidateAll } from '$app/navigation';
	import { api } from '$lib/api';
	import Modal from '$lib/components/Modal.svelte';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import { confirmDialog } from '$lib/components/dialogs.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import {
		createsLines,
		declaredInputs,
		missingRequired,
		renderStarter,
		suggestProjectName
	} from '$lib/starter-preview';

	let {
		open = $bindable(false),
		starters
	}: {
		open?: boolean;
		/** The starter menu, from the page load (`listStarters()`). */
		starters: StarterSummary[];
	} = $props();

	/** Blank is preselected, so a returning user's flow is unchanged. */
	const firstId = $derived(starters[0]?.id ?? 'blank');

	/**
	 * Every key any starter declares, so `bind:value` always has a string to
	 * bind to — switching starters must not hand a control `undefined`.
	 */
	function emptyInputs(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const s of starters) for (const spec of s.inputs) out[spec.key] = '';
		return out;
	}

	let starterId = $state<string>('blank');
	/** Raw text per declared input key; kept across switches, filtered on submit. */
	let inputs = $state<Record<string, string>>({});
	let name = $state('');
	/** Once the user types in Name, repository suggestions stop following. */
	let nameDirty = $state(false);
	let description = $state('');
	let conventions = $state('');
	/** Once the user types in the textarea, the prefill stops following. */
	let conventionsDirty = $state(false);
	let creating = $state(false);
	let createError = $state<string | null>(null);

	const selected = $derived(starters.find((s) => s.id === starterId) ?? starters[0]);
	const preview = $derived(selected ? renderStarter(selected, inputs, name) : null);
	const missing = $derived(selected ? missingRequired(selected, inputs) : []);
	const lines = $derived(preview ? createsLines(preview, conventions.trim() !== '') : []);

	// A pristine textarea always mirrors the rendered template, so typing the
	// Plan brief updates the prefill live. Reads `conventionsDirty` and
	// `preview`, writes `conventions` only, so it cannot loop.
	$effect(() => {
		if (!conventionsDirty) conventions = preview?.conventions ?? '';
	});

	// A pristine Name follows the selected repository starter's URL. Reads the
	// starter and raw inputs directly (not `preview`, which itself reads Name),
	// and writes Name only, so it cannot loop.
	$effect(() => {
		const suggestion = suggestProjectName(selected, inputs);
		if (!nameDirty) name = suggestion ?? '';
	});

	// Reset whenever the dialog closes (also seeds the first open), so Cancel,
	// Escape, the backdrop, a success and a deep-linked reopen all start clean.
	$effect(() => {
		if (!open) {
			starterId = firstId;
			inputs = emptyInputs();
			name = '';
			nameDirty = false;
			description = '';
			conventions = '';
			conventionsDirty = false;
			createError = null;
		}
	});

	/**
	 * Which control an input gets, from the spec rather than its key: a cap
	 * above a single line's worth of text (or no cap at all) means free-form
	 * prose. Keeps the dialog content-agnostic — a starter can rename its
	 * inputs without this file knowing.
	 */
	function multiline(spec: StarterInputSpec): boolean {
		return (spec.max ?? 10_000) > 1000;
	}

	function starterIcon(id: string) {
		if (id === 'code') return IconGitBranch;
		if (id === 'plan') return IconBulb;
		if (id === 'blank') return IconFile;
		return IconSparkles;
	}

	async function selectStarter(id: string) {
		if (id === starterId) return;
		const next = starters.find((s) => s.id === id);
		const nextText = next ? (renderStarter(next, inputs, name).conventions ?? '') : '';
		// Only ask when there is something of the user's to lose.
		if (conventionsDirty && conventions !== nextText) {
			const nextName = next?.name ?? id;
			// A starter with no template (Blank) does not *replace* the text, it
			// empties the field — say which of the two is about to happen.
			const replace = await confirmDialog({
				title: 'Replace your conventions?',
				body: nextText
					? `Switching to “${nextName}” replaces the text you edited with its template.`
					: `Switching to “${nextName}” discards the text you edited — it has no template.`,
				confirmLabel: 'Replace',
				cancelLabel: 'Keep mine'
			});
			// The switch itself is what the user clicked; only the textarea is
			// at stake, so the starter changes either way.
			if (replace) conventionsDirty = false;
		}
		starterId = id;
	}

	function onChooserKeydown(e: KeyboardEvent) {
		const delta = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
		if (delta === 0 || starters.length === 0) return;
		e.preventDefault();
		const at = starters.findIndex((s) => s.id === starterId);
		const next = starters[(at + delta + starters.length) % starters.length];
		// Roving tabindex: the arrow moves the selection, so it must move focus
		// with it or the next arrow press fires from a tabindex=-1 button.
		const group = (e.currentTarget as HTMLElement).parentElement;
		void selectStarter(next.id).then(() =>
			group?.querySelector<HTMLElement>(`[data-testid="starter-${next.id}"]`)?.focus()
		);
	}

	async function create(e: SubmitEvent) {
		e.preventDefault();
		if (creating || !selected) return;
		creating = true;
		createError = null;
		try {
			const project = await api.createProject({
				name,
				description,
				// Verbatim: the dialog owns this field, so a present '' means
				// "no conventions item" and never falls back to the template.
				initial_prompt: conventions,
				starter: { id: selected.id, inputs: declaredInputs(selected, inputs) }
			});
			open = false;
			await invalidateAll();
			await goto(`/projects/${project.id}`, {
				...(project.starter?.first_issue
					? {
							state: {
								starterLanding: {
									projectId: project.id,
									firstIssueId: project.starter.first_issue.id
								}
							}
						}
					: {})
			});
		} catch (err) {
			createError = err instanceof ApiError ? err.message : 'Failed to create project.';
		} finally {
			creating = false;
		}
	}
</script>

<Modal bind:open title="New project">
	<form onsubmit={create} class="space-y-4">
		<div class="space-y-1.5">
			<span class="text-sm font-medium" id="starter-label">Start from</span>
			<div role="radiogroup" aria-labelledby="starter-label" class="flex flex-col gap-2">
				{#each starters as starter (starter.id)}
					{@const isSelected = starter.id === selected?.id}
					{@const Icon = starterIcon(starter.id)}
					<button
						type="button"
						role="radio"
						aria-checked={isSelected}
						tabindex={isSelected ? 0 : -1}
						data-testid="starter-{starter.id}"
						onclick={() => selectStarter(starter.id)}
						onkeydown={onChooserKeydown}
						class="flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors {isSelected
							? 'border-ring bg-accent/40'
							: 'hover:bg-accent/30'}"
					>
						<Icon size={18} stroke={1.75} class="text-muted-foreground mt-0.5 shrink-0" />
						<span class="min-w-0">
							<span class="block text-sm font-medium">{starter.name}</span>
							<span class="text-muted-foreground block text-xs">{starter.description}</span>
						</span>
					</button>
				{/each}
			</div>
		</div>

		{#each selected?.inputs ?? [] as spec (spec.key)}
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="starter-{spec.key}">
					{spec.label}
					{#if !spec.required}<span class="text-muted-foreground font-normal">(optional)</span>{/if}
				</label>
				{#if multiline(spec)}
					<Textarea
						id="starter-{spec.key}"
						bind:value={inputs[spec.key]}
						rows={2}
						required={spec.required}
					/>
				{:else}
					<Input id="starter-{spec.key}" bind:value={inputs[spec.key]} required={spec.required} />
				{/if}
				{#if spec.description}
					<p class="text-muted-foreground text-xs">{spec.description}</p>
				{/if}
			</div>
		{/each}

		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="project-name">Name</label>
			<Input
				id="project-name"
				bind:value={name}
				oninput={() => (nameDirty = true)}
				maxlength={PROJECT_NAME_MAX}
				aria-describedby="project-name-hint"
				placeholder="e.g. website"
				required
			/>
			<p id="project-name-hint" class="text-muted-foreground text-xs">
				Maximum {PROJECT_NAME_MAX} characters.
			</p>
		</div>
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="project-description">Description</label>
			<Textarea
				id="project-description"
				bind:value={description}
				rows={3}
				placeholder="What is this project about?"
			/>
		</div>
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="project-prompt">
				How work is done here <span class="text-muted-foreground font-normal">(optional)</span>
			</label>
			<Textarea
				id="project-prompt"
				bind:value={conventions}
				oninput={() => (conventionsDirty = true)}
				rows={Math.min(8, Math.max(4, conventions.split('\n').length))}
				placeholder="Stitched into the prompt of every agent working in this project — who decides what, what “done” looks like, anything to leave alone…"
			/>
			<p class="text-muted-foreground text-xs">
				Saved as a project-scoped context prompt named “conventions”; editable any time.
			</p>
		</div>

		<div class="bg-muted/40 rounded-md border p-3 text-sm">
			<p class="font-medium">This creates:</p>
			{#if lines.length === 0}
				<p class="text-muted-foreground mt-1">
					An empty project — add workflows, context and issues yourself.
				</p>
			{:else}
				<ul aria-label="This creates" class="text-muted-foreground mt-1 space-y-0.5">
					{#each lines as line, index (index)}
						<li class="line-clamp-3 break-words whitespace-pre-wrap" title={line}>{line}</li>
					{/each}
				</ul>
			{/if}
		</div>

		{#if createError}
			<p class="text-destructive text-sm">{createError}</p>
		{/if}
		<div class="flex flex-wrap justify-end gap-2">
			<Button type="button" variant="ghost" disabled={creating} onclick={() => (open = false)}>
				Cancel
			</Button>
			<PendingButton
				type="submit"
				pending={creating}
				pendingLabel="Creating…"
				disabled={!name.trim() || missing.length > 0}
			>
				Create project
			</PendingButton>
		</div>
	</form>
</Modal>
