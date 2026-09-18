<script lang="ts">
	import type {
		ContextFile,
		ContextItem,
		ContextKind,
		CreateContextItemRequest,
		Issue,
		IssueListItem,
		LabelWithUsage,
		Project,
		UpdateContextItemRequest,
		WorkflowResponse
	} from '@tines/shared';
	import { ApiError, CONTEXT_KINDS, repoDirFromUrl } from '@tines/shared';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import IconTrash from '@tabler/icons-svelte/icons/trash';
	import { api } from '$lib/api';
	import ContextKindIcon from '$lib/components/ContextKindIcon.svelte';
	import { confirmDialog } from '$lib/components/dialogs.svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';

	interface ScopeDefaults {
		project_id?: string;
		workflow_state_id?: string;
		label_id?: string;
		issue_id?: string;
	}

	let {
		open = $bindable(false),
		item = null,
		defaults = {},
		defaultKind,
		projects,
		workflows,
		onsaved
	}: {
		open?: boolean;
		/** Null = create; an item = edit (kind locked). */
		item?: ContextItem | null;
		/** Scope pre-filled on create (e.g. "attach to this issue"). */
		defaults?: ScopeDefaults;
		/** Kind pre-selected on create, when the caller opened the editor for a specific one. */
		defaultKind?: ContextKind;
		projects: Project[];
		workflows: WorkflowResponse[];
		onsaved?: () => void | Promise<void>;
	} = $props();

	const KIND_LABELS: Record<ContextKind, string> = {
		prompt: 'Prompt — Markdown stitched into the agent prompt',
		skill: 'Skill — text files seeded into the workspace',
		repo: 'Repo — a repository to check out',
		artifact: 'Artifact — a versioned attachment (created from an issue page)'
	};
	// Artifacts are created through their own endpoints/panel, never here.
	const CREATABLE_KINDS = CONTEXT_KINDS.filter((k) => k !== 'artifact');

	let kind = $state<ContextKind>('prompt');
	let name = $state('');
	let description = $state('');
	let projectId = $state('');
	let stateId = $state('');
	let labelId = $state('');
	let issueId = $state('');
	let body = $state('');
	let previewBody = $state(false);
	interface FileRow {
		key: number;
		path: string;
		content: string;
	}
	let nextFileKey = 0;
	let files = $state<FileRow[]>([]);
	// False while an opened skill's files are still being fetched (or the
	// fetch failed): saving then would PATCH an empty list and delete them.
	let filesReady = $state(true);
	let repoUrl = $state('');
	let repoBranch = $state('');
	let repoDir = $state('');
	let errorMessage = $state<string | null>(null);
	let saving = $state(false);

	// Seed the form each time the dialog opens (create defaults or the item).
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			errorMessage = null;
			previewBody = false;
			kind = item?.kind ?? defaultKind ?? 'prompt';
			name = item?.name ?? '';
			description = item?.description ?? '';
			projectId = item ? (item.scope.project_id ?? '') : (defaults.project_id ?? '');
			stateId = item ? (item.scope.workflow_state_id ?? '') : (defaults.workflow_state_id ?? '');
			labelId = item ? (item.scope.label_id ?? '') : (defaults.label_id ?? '');
			issueId = item ? (item.scope.issue_id ?? '') : (defaults.issue_id ?? '');
			body = item?.body ?? '';
			files = (item?.files ?? []).map((f) => ({
				key: nextFileKey++,
				path: f.path,
				content: f.content
			}));
			// List rows carry only a file count; fetch the files for editing.
			// Until they arrive, saving is blocked — a PATCH built from the
			// placeholder empty list would delete every file in the skill.
			filesReady = true;
			boundIssue = null;
			boundIssueRequested = '';
			if (item && item.kind === 'skill' && item.files === undefined) {
				filesReady = false;
				const itemId = item.id;
				api
					.getContextItem(itemId)
					.then((full) => {
						if (!open || item?.id !== itemId) return;
						files = (full.files ?? []).map((f) => ({
							key: nextFileKey++,
							path: f.path,
							content: f.content
						}));
						filesReady = true;
					})
					.catch(() => {
						if (!open || item?.id !== itemId) return;
						errorMessage =
							'Couldn’t load this skill’s files — close the dialog and reopen to retry.';
					});
			}
			repoUrl = item?.repo_url ?? '';
			repoBranch = item?.repo_branch ?? '';
			repoDir = item?.repo_dir ?? '';
			// Labels are small and rarely change, so one fetch per open is
			// cheaper than threading them through all four call sites. A
			// failure leaves the select empty rather than blocking the save:
			// an item's existing label_id is preserved by the option below.
			if (labels.length === 0) {
				api
					.listLabels()
					.then((res) => {
						labels = res.items;
					})
					.catch(() => {});
			}
		}
		wasOpen = open;
	});

	let labels = $state<LabelWithUsage[]>([]);
	// The item's own label, when the list has not arrived (or no longer has
	// it): without an option carrying the current value the select would
	// silently reset the scope to "any label" on save.
	const missingLabel = $derived(
		labelId && !labels.some((l) => l.id === labelId) ? (item?.scope.label_name ?? labelId) : null
	);

	// --- scope coherence, enforced live -------------------------------------

	// Issues for the issue selector, constrained to the chosen project. Only
	// the latest request may land: switching projects fires overlapping
	// fetches whose responses can resolve out of order.
	let issues = $state<IssueListItem[]>([]);
	let issuesRequest = 0;
	$effect(() => {
		if (!open) return;
		const project = projectId;
		const token = ++issuesRequest;
		api
			.listIssues({ project: project || undefined, limit: 100 })
			.then((res) => {
				if (token === issuesRequest) issues = res.items;
			})
			.catch(() => {
				if (token === issuesRequest) issues = [];
			});
	});

	// The list is capped at 100 issues, so an item's bound issue may not be in
	// it — without this fetch the select would render blank, hiding the item's
	// real scope from whoever is editing it.
	let boundIssue = $state<Issue | null>(null);
	let boundIssueRequested = '';
	$effect(() => {
		const id = issueId;
		if (!id || issues.some((i) => i.id === id) || boundIssueRequested === id) return;
		boundIssueRequested = id;
		api
			.getIssue(id)
			.then((full) => {
				if (issueId === id) boundIssue = full;
			})
			.catch(() => {});
	});

	const selectedIssue = $derived(
		issues.find((i) => i.id === issueId) ?? (boundIssue?.id === issueId ? boundIssue : undefined)
	);
	/** The fetched list, with the bound issue prepended when it isn't in it. */
	const issueOptions = $derived(
		selectedIssue && !issues.some((i) => i.id === selectedIssue.id)
			? [selectedIssue, ...issues]
			: issues
	);

	// Picking an issue constrains the state list to its bound workflow.
	const stateWorkflows = $derived(
		selectedIssue ? workflows.filter((w) => w.id === selectedIssue.workflow_id) : workflows
	);

	// Keep the selections coherent as constraints change.
	$effect(() => {
		if (issueId && selectedIssue) {
			// The issue implies its project; drop a mismatched project pick.
			if (projectId && projectId !== selectedIssue.project_id) projectId = '';
			if (stateId && !stateWorkflows.some((w) => w.states.some((s) => s.id === stateId)))
				stateId = '';
		}
	});

	const derivedDir = $derived(repoUrl.trim() ? repoDirFromUrl(repoUrl.trim()) : '');
	const isGlobal = $derived(!projectId && !stateId && !labelId && !issueId);

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (saving) return;
		// Backstop behind the disabled button: never send a file list that was
		// never actually loaded.
		if (kind === 'skill' && !filesReady) return;
		saving = true;
		errorMessage = null;
		try {
			if (item) {
				const request: UpdateContextItemRequest = {
					name,
					description,
					// Surface concurrent edits (e.g. an agent's append) instead of
					// silently overwriting them.
					expected_version: item.version
				};
				// An artifact's scope is structural (exactly its issue) and the
				// server rejects any change; a merge-patch omitting it is a no-op.
				if (kind !== 'artifact') {
					request.project_id = projectId || null;
					request.workflow_state_id = stateId || null;
					request.label_id = labelId || null;
					request.issue_id = issueId || null;
				}
				if (kind === 'prompt') request.body = body;
				if (kind === 'skill')
					request.files = files.map(({ path, content }): ContextFile => ({ path, content }));
				if (kind === 'repo') {
					request.repo_url = repoUrl;
					request.repo_branch = repoBranch.trim() || null;
					request.repo_dir = repoDir.trim() || null;
				}
				await api.updateContextItem(item.id, request);
			} else {
				const request: CreateContextItemRequest = {
					kind,
					name,
					description: description || undefined,
					project_id: projectId || null,
					workflow_state_id: stateId || null,
					label_id: labelId || null,
					issue_id: issueId || null
				};
				if (kind === 'prompt') request.body = body;
				if (kind === 'skill')
					request.files = files.map(({ path, content }): ContextFile => ({ path, content }));
				if (kind === 'repo') {
					request.repo_url = repoUrl;
					request.repo_branch = repoBranch.trim() || null;
					request.repo_dir = repoDir.trim() || null;
				}
				await api.createContextItem(request);
			}
			open = false;
			await onsaved?.();
		} catch (err) {
			errorMessage = err instanceof ApiError ? err.message : 'Something went wrong — try again.';
		} finally {
			saving = false;
		}
	}

	async function deleteItem() {
		if (!item) return;
		const ok = await confirmDialog({
			title: `Delete ${item.kind} “${item.name}”?`,
			confirmLabel: 'Delete',
			destructive: true
		});
		if (!ok || !item) return;
		saving = true;
		try {
			await api.deleteContextItem(item.id);
			open = false;
			await onsaved?.();
		} catch (err) {
			errorMessage = err instanceof ApiError ? err.message : 'Something went wrong — try again.';
		} finally {
			saving = false;
		}
	}
</script>

<Modal bind:open title={item ? `Edit ${item.kind} “${item.name}”` : 'New context item'}>
	<form onsubmit={save} class="space-y-4">
		{#if !item}
			<div class="space-y-1.5">
				<span class="text-sm font-medium">Kind</span>
				<div class="grid gap-1.5">
					{#each CREATABLE_KINDS as k (k)}
						<label
							class="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm {kind ===
							k
								? 'border-primary bg-primary/5'
								: 'hover:bg-muted/50'}"
						>
							<input type="radio" name="kind" value={k} bind:group={kind} class="sr-only" />
							<ContextKindIcon kind={k} />
							{KIND_LABELS[k]}
						</label>
					{/each}
				</div>
			</div>
		{/if}

		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="ctx-name">Name</label>
			<Input
				id="ctx-name"
				bind:value={name}
				required
				placeholder={kind === 'skill' ? 'slug-like: review-checklist' : 'e.g. house conventions'}
			/>
			{#if kind === 'artifact'}
				<p class="text-muted-foreground text-xs">
					The requirement-matching key (slug-like) — renaming changes which transition requirements
					this artifact satisfies.
				</p>
			{:else if kind !== 'prompt'}
				<p class="text-muted-foreground text-xs">
					A more specific item with the same name overrides this one in the effective context.
				</p>
			{/if}
		</div>

		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="ctx-description">Description</label>
			<Input
				id="ctx-description"
				bind:value={description}
				placeholder="Optional one-liner shown in lists"
			/>
		</div>

		<!-- payload -->
		{#if kind === 'prompt'}
			<div class="space-y-1.5">
				<div class="flex items-center justify-between">
					<label class="text-sm font-medium" for="ctx-body">Body (Markdown)</label>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onclick={() => (previewBody = !previewBody)}
					>
						{previewBody ? 'Write' : 'Preview'}
					</Button>
				</div>
				{#if previewBody}
					<div class="max-h-64 overflow-y-auto rounded-md border p-3">
						<Markdown source={body || '*Nothing yet.*'} />
					</div>
				{:else}
					<Textarea
						id="ctx-body"
						bind:value={body}
						rows={8}
						placeholder="Stitched into the agent prompt under a “## Context: …” heading."
					/>
				{/if}
			</div>
		{:else if kind === 'skill'}
			<div class="space-y-2">
				<div class="flex items-center justify-between">
					<span class="text-sm font-medium">Files</span>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onclick={() => (files = [...files, { key: nextFileKey++, path: '', content: '' }])}
					>
						<IconPlus size={14} /> Add file
					</Button>
				</div>
				{#if files.length === 0}
					<p class="text-muted-foreground text-xs italic">
						No files yet — seeded into the workspace at skills/&lt;name&gt;/…
					</p>
				{/if}
				{#each files as file, i (file.key)}
					<div class="space-y-1.5 rounded-md border p-2">
						<div class="flex items-center gap-2">
							<Input
								bind:value={file.path}
								placeholder="SKILL.md"
								class="h-8 font-mono text-xs"
								aria-label="File {i + 1} path"
							/>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onclick={() => (files = files.filter((f) => f.key !== file.key))}
								aria-label="Remove file {file.path || i + 1}"
							>
								<IconTrash size={14} />
							</Button>
						</div>
						<Textarea
							bind:value={file.content}
							rows={4}
							class="font-mono text-xs"
							placeholder="File content…"
						/>
					</div>
				{/each}
			</div>
		{:else if kind === 'repo'}
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="ctx-url">Repository URL</label>
				<Input
					id="ctx-url"
					bind:value={repoUrl}
					required
					placeholder="https://github.com/acme/api.git"
				/>
			</div>
			<div class="grid grid-cols-2 gap-3">
				<div class="space-y-1.5">
					<label class="text-sm font-medium" for="ctx-branch">Branch</label>
					<Input id="ctx-branch" bind:value={repoBranch} placeholder="default branch" />
				</div>
				<div class="space-y-1.5">
					<label class="text-sm font-medium" for="ctx-dir">Checkout dir</label>
					<Input id="ctx-dir" bind:value={repoDir} placeholder={derivedDir || 'derived from URL'} />
				</div>
			</div>
		{:else}
			<p class="text-muted-foreground rounded-md border px-3 py-2 text-xs">
				This artifact's content and version history are managed from the Artifacts panel on its
				issue page{selectedIssue ? ` (${selectedIssue.project_name}/${selectedIssue.number})` : ''} —
				here you can rename it or edit its description.
			</p>
		{/if}

		<!-- scope: an artifact is pinned to exactly its issue, so there is nothing to choose -->
		{#if kind === 'artifact'}
			<p class="text-muted-foreground text-xs">
				Scoped to its issue{selectedIssue
					? `: ${selectedIssue.project_name}/${selectedIssue.number}`
					: ''} — an artifact's scope cannot be changed.
			</p>
		{:else}
			<fieldset class="space-y-2 rounded-md border p-3">
				<legend class="px-1 text-sm font-medium">Scope</legend>
				<p class="text-muted-foreground text-xs">
					Applies where <em>all</em> chosen dimensions match.
					{#if isGlobal}
						<span class="text-foreground font-medium"
							>None chosen — global: applies to every launch prompt.</span
						>
					{/if}
				</p>
				{#if !issueId}
					<div class="space-y-1">
						<label class="text-muted-foreground text-xs font-medium" for="ctx-scope-project"
							>Project</label
						>
						<Select id="ctx-scope-project" bind:value={projectId} class="h-8 text-xs">
							<option value="">Any project</option>
							{#each projects as project (project.id)}
								<option value={project.id}>{project.name}</option>
							{/each}
						</Select>
					</div>
				{/if}
				<div class="space-y-1">
					<label class="text-muted-foreground text-xs font-medium" for="ctx-scope-state">
						Only in state{selectedIssue
							? ` (workflow of ${selectedIssue.project_name}/${selectedIssue.number})`
							: ''}
					</label>
					<Select id="ctx-scope-state" bind:value={stateId} class="h-8 text-xs">
						<option value="">Any state</option>
						{#each stateWorkflows as workflow (workflow.id)}
							{#each workflow.states as state (state.id)}
								<option value={state.id}>{workflow.name} / {state.name}</option>
							{/each}
						{/each}
					</Select>
				</div>
				<div class="space-y-1">
					<label class="text-muted-foreground text-xs font-medium" for="ctx-scope-label"
						>Only on issues labelled</label
					>
					<Select id="ctx-scope-label" bind:value={labelId} class="h-8 text-xs">
						<option value="">Any label</option>
						{#if missingLabel}
							<option value={labelId}>{missingLabel}</option>
						{/if}
						{#each labels as label (label.id)}
							<option value={label.id}>{label.name}</option>
						{/each}
					</Select>
				</div>
				<div class="space-y-1">
					<label class="text-muted-foreground text-xs font-medium" for="ctx-scope-issue"
						>Only for issue</label
					>
					<Select id="ctx-scope-issue" bind:value={issueId} class="h-8 text-xs">
						<option value="">Any issue</option>
						{#each issueOptions as issue (issue.id)}
							<option value={issue.id}>{issue.project_name}/{issue.number} — {issue.title}</option>
						{/each}
					</Select>
					{#if issueId}
						<p class="text-muted-foreground text-xs">The issue implies its project.</p>
					{/if}
				</div>
			</fieldset>
		{/if}

		{#if errorMessage}
			<p
				class="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs"
			>
				{errorMessage}
			</p>
		{/if}

		<div class="flex items-center justify-between gap-2 pt-1">
			{#if item}
				<Button type="button" variant="destructive" onclick={deleteItem} disabled={saving}
					>Delete</Button
				>
			{:else}
				<span></span>
			{/if}
			<div class="flex flex-wrap gap-2">
				<Button type="button" variant="ghost" disabled={saving} onclick={() => (open = false)}>
					Cancel
				</Button>
				<PendingButton
					type="submit"
					pending={saving}
					pendingLabel="Saving…"
					disabled={!name.trim() || (kind === 'skill' && !filesReady)}
				>
					{kind === 'skill' && !filesReady ? 'Loading files…' : item ? 'Save' : 'Create'}
				</PendingButton>
			</div>
		</div>
	</form>
</Modal>
