<script lang="ts">
	import type { ContextItem, ContextKind } from '@tines/shared';
	import { activeStateIds as deriveActiveStateIds, ApiError } from '@tines/shared';
	import IconArchive from '@tabler/icons-svelte/icons/archive';
	import IconChevronLeft from '@tabler/icons-svelte/icons/chevron-left';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import IconSettings from '@tabler/icons-svelte/icons/settings';
	import { slide } from 'svelte/transition';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import AgentRoutingCard from '$lib/components/AgentRoutingCard.svelte';
	import ContextItemEditor from '$lib/components/ContextItemEditor.svelte';
	import ContextItemList from '$lib/components/ContextItemList.svelte';
	import { confirmDialog } from '$lib/components/dialogs.svelte';
	import IssueFilterBar from '$lib/components/IssueFilterBar.svelte';
	import IssueList from '$lib/components/IssueList.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import NewIssueModal from '$lib/components/NewIssueModal.svelte';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import ScheduleList from '$lib/components/ScheduleList.svelte';
	import StateBadge from '$lib/components/StateBadge.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { PROJECT_ARCHIVED_TOOLTIP } from '$lib/archived';
	import { groupContextByWorkflow } from '$lib/context-groups';
	import { formatDate, prefersReducedMotion } from '$lib/format';
	import { navMemory } from '$lib/nav-memory.svelte';

	let { data } = $props();

	// Remember this list (filters and all) so an issue opened from here gets a
	// back link that returns to it.
	$effect(() => {
		navMemory.recordProject(data.project.id, page.url.search, data.project.name);
	});

	/** An archived project reads normally and writes nowhere. */
	const archived = $derived(data.project.archived_at !== null);
	const reason = $derived(archived ? PROJECT_ARCHIVED_TOOLTIP : null);

	/** Active-category states, so dead routing rules are flagged as such. */
	const activeStateIds = $derived(deriveActiveStateIds(data.workflows));

	const dur = () => (prefersReducedMotion() ? 0 : 180);

	let errorMessage = $state<string | null>(null);
	function showError(e: unknown) {
		errorMessage = e instanceof ApiError ? e.message : 'Something went wrong — try again.';
		setTimeout(() => (errorMessage = null), 6000);
	}

	// --- archive -----------------------------------------------------------------

	/** Named runs still finishing on their own issue, after an archive. */
	let archiveNotice = $state<string | null>(null);

	function plural(n: number, noun: string): string {
		return `${n} ${noun}${n === 1 ? '' : 's'}`;
	}

	async function archive() {
		const name = data.project.name;
		const ok = await confirmDialog({
			title: `Archive "${name}"?`,
			body:
				`Archiving hides ${name} from lists and pickers, pauses its ` +
				`${plural(data.schedules.length, 'scheduled task')}, stops agents dispatching on it, and ` +
				`makes its ${plural(data.project.issue_count, 'issue')} read-only. Runs already under way ` +
				`are allowed to finish. Links and refs keep working. You can unarchive at any time.`,
			confirmLabel: 'Archive project'
		});
		if (!ok) return;
		try {
			const res = await api.archiveProject(data.project.id);
			settingsOpen = false;
			archiveNotice = res.draining_runs.length
				? `${plural(res.draining_runs.length, 'run')} still finishing: ` +
					res.draining_runs.map((r) => `${r.runner_name} on #${r.issue_number}`).join(', ') +
					'. They keep their own issue writable until they end.'
				: null;
			await invalidateAll();
		} catch (err) {
			showError(err);
		}
	}

	let unarchiving = $state(false);
	async function unarchive() {
		unarchiving = true;
		try {
			await api.unarchiveProject(data.project.id);
			archiveNotice = null;
			settingsOpen = false;
			await invalidateAll();
		} catch (err) {
			showError(err);
		} finally {
			unarchiving = false;
		}
	}

	let newIssueOpen = $state(false);
	let newIssueRepeatOpen = $state(false);

	function openNewSchedule() {
		newIssueRepeatOpen = true;
		newIssueOpen = true;
	}

	// --- context -----------------------------------------------------------------

	let contextEditorOpen = $state(false);
	let editingContextItem = $state<ContextItem | null>(null);
	let contextDefaultKind = $state<ContextKind>('prompt');

	function openContextCreate(kind: ContextKind = 'prompt') {
		editingContextItem = null;
		contextDefaultKind = kind;
		contextEditorOpen = true;
	}
	function openContextEdit(item: ContextItem) {
		editingContextItem = item;
		contextEditorOpen = true;
	}

	// Project-only items stay expanded; project ∧ state items collapse into one
	// accordion row per workflow (issue-anchored items are excluded server-side).
	const projectOnlyItems = $derived(data.contextItems.filter((i) => !i.scope.workflow_state_id));
	const workflowGroups = $derived(groupContextByWorkflow(data.contextItems, data.workflows));
	/** The one open accordion row, or null — closed by default. */
	let openWorkflowId = $state<string | null>(null);

	// --- settings ----------------------------------------------------------------

	let settingsOpen = $state(false);
	// Seeded once, resynced by the $effect below when server data refreshes.
	// svelte-ignore state_referenced_locally
	let settingsName = $state(data.project.name);
	// svelte-ignore state_referenced_locally
	let settingsDescription = $state(data.project.description);
	// svelte-ignore state_referenced_locally
	let settingsDefaultWorkflow = $state(data.project.default_workflow_id ?? '');
	let savingSettings = $state(false);
	$effect(() => {
		settingsName = data.project.name;
		settingsDescription = data.project.description;
		settingsDefaultWorkflow = data.project.default_workflow_id ?? '';
	});

	async function saveSettings(e: SubmitEvent) {
		e.preventDefault();
		savingSettings = true;
		try {
			await api.updateProject(data.project.id, {
				name: settingsName,
				description: settingsDescription,
				default_workflow_id: settingsDefaultWorkflow || null
			});
			settingsOpen = false;
			await invalidateAll();
		} catch (err) {
			showError(err);
		} finally {
			savingSettings = false;
		}
	}

	async function deleteProject() {
		const ok = await confirmDialog({
			title: `Delete project "${data.project.name}"?`,
			body: 'This cannot be undone.',
			confirmLabel: 'Delete project',
			destructive: true
		});
		if (!ok) return;
		try {
			await api.deleteProject(data.project.id);
			await goto('/projects');
			await invalidateAll();
		} catch (err) {
			// Context scoped to the project blocks deletion; list what a forced
			// delete would sweep and offer it.
			if (err instanceof ApiError && err.code === 'context_attached') {
				const items = (err.details?.context_items ?? []) as {
					kind: string;
					name: string;
					scope_label: string;
				}[];
				const sweep = await confirmDialog({
					title: 'Delete attached context too?',
					body: `Deleting "${data.project.name}" also deletes ${items.length} context item${items.length === 1 ? '' : 's'}:`,
					items: items.map((i) => `${i.kind} “${i.name}” (${i.scope_label})`),
					confirmLabel: 'Delete them',
					destructive: true
				});
				if (sweep) {
					try {
						await api.deleteProject(data.project.id, { force_delete_context: true });
						await goto('/projects');
						await invalidateAll();
					} catch (err2) {
						showError(err2);
					}
				}
				return;
			}
			showError(err);
		}
	}
</script>

<svelte:head><title>{data.project.name} · Tines</title></svelte:head>

<a
	href="/projects"
	class="text-muted-foreground hover:text-foreground mb-3 inline-flex items-center gap-1 text-sm"
>
	<IconChevronLeft size={16} /> Projects
</a>

<div class="mb-6 flex flex-wrap items-start justify-between gap-4">
	<div class="min-w-0">
		<h1 class="text-2xl font-semibold tracking-tight">{data.project.name}</h1>
		{#if data.project.description}
			<p class="text-muted-foreground mt-1 max-w-xl text-sm">{data.project.description}</p>
		{/if}
	</div>
	<div class="flex gap-2">
		<Button variant="outline" onclick={() => (settingsOpen = true)}>
			<IconSettings size={16} /> Settings
		</Button>
		{#if !archived}
			<Button onclick={() => (newIssueOpen = true)}>
				<IconPlus size={16} /> New issue
			</Button>
		{/if}
	</div>
</div>

{#if archived}
	<div
		class="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-300"
		transition:slide={{ duration: dur() }}
	>
		<IconArchive size={16} />
		<span>Archived {formatDate(data.project.archived_at!)}</span>
		<span aria-hidden="true">·</span>
		<PendingButton
			size="sm"
			variant="outline"
			pending={unarchiving}
			pendingLabel="Unarchiving…"
			onclick={unarchive}
		>
			Unarchive
		</PendingButton>
	</div>
{/if}

{#if archiveNotice}
	<div
		class="bg-muted/40 mb-4 flex flex-wrap items-center gap-2 rounded-md border px-4 py-2.5 text-sm"
	>
		<span class="min-w-0">{archiveNotice}</span>
		<Button size="sm" variant="ghost" onclick={() => (archiveNotice = null)}>Dismiss</Button>
	</div>
{/if}

{#if errorMessage}
	<div
		class="border-destructive/40 bg-destructive/10 text-destructive mb-4 rounded-md border px-4 py-2.5 text-sm"
		transition:slide={{ duration: dur() }}
	>
		{errorMessage}
	</div>
{/if}

<div class="mb-8">
	<h2 class="mb-3 text-sm font-semibold">Issues</h2>
	<!-- The same bar as the all-issues list, minus the project scope. -->
	<IssueFilterBar
		filters={data.filters}
		counts={data.counts}
		labels={data.labels}
		workflows={data.workflows}
	/>

	<IssueList
		issues={data.issues}
		showProject={false}
		emptyMessage={data.filters.ready
			? 'No ready issues in this project.'
			: data.filters.category || data.filters.q || data.filters.labels.length > 0
				? 'No issues match these filters.'
				: 'No issues in this project yet.'}
	/>
</div>

{#if data.schedules.length > 0}
	<div class="mb-8">
		<div class="mb-3 flex items-center justify-between">
			<h2 class="text-sm font-semibold">Scheduled tasks</h2>
			{#if !archived}
				<Button size="sm" variant="ghost" onclick={openNewSchedule} aria-label="Add scheduled task">
					<IconPlus size={14} /> Add
				</Button>
			{/if}
		</div>
		<ScheduleList
			schedules={data.schedules}
			workflows={data.workflows}
			highlightId={page.url.searchParams.get('schedule')}
			disabledReason={reason}
			onerror={showError}
		/>
	</div>
{/if}

<AgentRoutingCard
	rules={data.routingRules}
	{activeStateIds}
	emptyMessage="No routing rule covers this project — its issues will not dispatch to agents."
	emptyAction={{ label: 'Set up routing', href: '/agents#routing' }}
/>

<div class="mb-8">
	<div class="mb-3 flex items-center justify-between">
		<h2 class="text-sm font-semibold">Context</h2>
		<div class="flex items-center gap-3">
			<a
				href="/context?project={data.project.id}"
				class="text-muted-foreground hover:text-foreground text-xs"
			>
				View all in Context
			</a>
			{#if !archived}
				<Button
					size="sm"
					variant="ghost"
					onclick={() => openContextCreate()}
					aria-label="Add context"
				>
					<IconPlus size={14} /> Add
				</Button>
			{/if}
		</div>
	</div>
	{#if data.contextItems.length === 0}
		<div class="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
			No context for this project yet — attach conventions, skills, or repos that every issue here
			should carry.
			{#if !archived}
				<div class="mt-3">
					<Button size="sm" variant="outline" onclick={() => openContextCreate('repo')}>
						<IconPlus size={14} /> Add a repo
					</Button>
				</div>
			{/if}
		</div>
	{:else}
		<div class="space-y-4">
			{#if projectOnlyItems.length > 0}
				<ContextItemList
					items={projectOnlyItems}
					showScope={false}
					onselect={archived ? undefined : openContextEdit}
				/>
			{/if}
			{#if workflowGroups.length > 0}
				<div>
					<h3 class="text-muted-foreground mb-1.5 text-xs font-semibold">
						Only in a workflow state
					</h3>
					<div class="rounded-lg border">
						{#each workflowGroups as group (group.workflowId)}
							{@const open = openWorkflowId === group.workflowId}
							{@const panelId = `project-context-${group.workflowId}`}
							<div class="border-b last:border-0">
								<button
									type="button"
									class="hover:bg-muted/50 flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm"
									onclick={() => (openWorkflowId = open ? null : group.workflowId)}
									aria-expanded={open}
									aria-controls={panelId}
								>
									<span class="font-medium">{group.workflowName}</span>
									<span
										class="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-xs font-medium"
									>
										{group.states.length} state{group.states.length === 1 ? '' : 's'} ·
										{group.itemCount} item{group.itemCount === 1 ? '' : 's'}
									</span>
								</button>
								{#if open}
									<div
										id={panelId}
										class="space-y-3 px-3 pb-3"
										transition:slide={{ duration: dur() }}
									>
										{#each group.states as stateGroup (stateGroup.stateId)}
											<div>
												<h4 class="mb-1.5"><StateBadge state={stateGroup.state} /></h4>
												<ContextItemList
													items={stateGroup.items}
													showScope={false}
													onselect={archived ? undefined : openContextEdit}
												/>
											</div>
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>

<!-- new issue -->
<NewIssueModal
	bind:open={newIssueOpen}
	bind:repeatOpen={newIssueRepeatOpen}
	projects={[data.project]}
	workflows={data.workflows}
	project={data.project}
/>

<!-- context editor: create defaults the scope to this project -->
<ContextItemEditor
	bind:open={contextEditorOpen}
	item={editingContextItem}
	defaults={{ project_id: data.project.id }}
	defaultKind={contextDefaultKind}
	projects={[data.project]}
	workflows={data.workflows}
	onsaved={invalidateAll}
/>

<!-- settings -->
<Modal bind:open={settingsOpen} title="Project settings">
	<form onsubmit={saveSettings} class="space-y-4">
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="settings-name">Name</label>
			<Input id="settings-name" bind:value={settingsName} required disabled={archived} />
		</div>
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="settings-description">Description</label>
			<Textarea
				id="settings-description"
				bind:value={settingsDescription}
				rows={3}
				disabled={archived}
			/>
		</div>
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="settings-workflow">Default workflow</label>
			<Select id="settings-workflow" bind:value={settingsDefaultWorkflow} disabled={archived}>
				<option value="">Standard (built-in)</option>
				{#each data.workflows.filter((w) => !w.is_system) as workflow (workflow.id)}
					<option value={workflow.id}>{workflow.name}</option>
				{/each}
			</Select>
		</div>
		<div class="flex items-center justify-between gap-2 pt-2">
			<div class="flex flex-wrap gap-2">
				{#if archived}
					<PendingButton
						type="button"
						variant="outline"
						pending={unarchiving}
						pendingLabel="Unarchiving…"
						onclick={unarchive}
					>
						Unarchive
					</PendingButton>
				{:else}
					<Button type="button" variant="outline" onclick={archive}>Archive project</Button>
				{/if}
				<Button
					type="button"
					variant="destructive"
					disabled={data.project.issue_count > 0}
					title={data.project.issue_count > 0
						? 'Projects with issues cannot be deleted'
						: undefined}
					onclick={deleteProject}
				>
					Delete project
				</Button>
			</div>
			<div class="flex flex-wrap gap-2">
				<Button
					type="button"
					variant="ghost"
					disabled={savingSettings}
					onclick={() => (settingsOpen = false)}
				>
					Cancel
				</Button>
				{#if !archived}
					<PendingButton
						type="submit"
						pending={savingSettings}
						pendingLabel="Saving…"
						disabled={!settingsName.trim()}
					>
						Save
					</PendingButton>
				{/if}
			</div>
		</div>
	</form>
</Modal>
