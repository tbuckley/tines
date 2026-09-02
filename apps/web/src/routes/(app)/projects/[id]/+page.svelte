<script lang="ts">
	import type { ContextItem } from '@tines/shared';
	import { activeStateIds as deriveActiveStateIds, ApiError } from '@tines/shared';
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
	import IssueList from '$lib/components/IssueList.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import NewIssueModal from '$lib/components/NewIssueModal.svelte';
	import ScheduleList from '$lib/components/ScheduleList.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { prefersReducedMotion } from '$lib/format';

	let { data } = $props();

	/** Active-category states, so dead routing rules are flagged as such. */
	const activeStateIds = $derived(deriveActiveStateIds(data.workflows));

	const dur = () => (prefersReducedMotion() ? 0 : 180);

	let errorMessage = $state<string | null>(null);
	function showError(e: unknown) {
		errorMessage = e instanceof ApiError ? e.message : 'Something went wrong — try again.';
		setTimeout(() => (errorMessage = null), 6000);
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

	function openContextCreate() {
		editingContextItem = null;
		contextEditorOpen = true;
	}
	function openContextEdit(item: ContextItem) {
		editingContextItem = item;
		contextEditorOpen = true;
	}

	// Project-only items first, then project ∧ state grouped under their
	// state names (issue-anchored items are excluded server-side).
	const projectOnlyItems = $derived(data.contextItems.filter((i) => !i.scope.workflow_state_id));
	const stateGroups = $derived.by(() => {
		const groups = new Map<string, { label: string; items: ContextItem[] }>();
		for (const item of data.contextItems) {
			if (!item.scope.workflow_state_id) continue;
			const key = item.scope.workflow_state_id;
			const group = groups.get(key) ?? {
				label: `${item.scope.workflow_name} / ${item.scope.workflow_state_name}`,
				items: []
			};
			group.items.push(item);
			groups.set(key, group);
		}
		return [...groups.values()];
	});

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

	function setFilter(key: string, on: boolean) {
		const params = new URLSearchParams(page.url.searchParams);
		if (on) params.set(key, '1');
		else params.delete(key);
		goto(`/projects/${data.project.id}?${params}`, { keepFocus: true, noScroll: true });
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
		<Button onclick={() => (newIssueOpen = true)}>
			<IconPlus size={16} /> New issue
		</Button>
	</div>
</div>

{#if errorMessage}
	<div
		class="border-destructive/40 bg-destructive/10 text-destructive mb-4 rounded-md border px-4 py-2.5 text-sm"
		transition:slide={{ duration: dur() }}
	>
		{errorMessage}
	</div>
{/if}

{#if data.schedules.length > 0}
	<div class="mb-8">
		<div class="mb-3 flex items-center justify-between">
			<h2 class="text-sm font-semibold">Scheduled tasks</h2>
			<Button size="sm" variant="ghost" onclick={openNewSchedule} aria-label="Add scheduled task">
				<IconPlus size={14} /> Add
			</Button>
		</div>
		<ScheduleList
			schedules={data.schedules}
			workflows={data.workflows}
			highlightId={page.url.searchParams.get('schedule')}
			onerror={showError}
		/>
	</div>
{/if}

<div class="mb-8">
	<div class="mb-3 flex items-center justify-between">
		<h2 class="text-sm font-semibold">Context</h2>
		<Button size="sm" variant="ghost" onclick={openContextCreate} aria-label="Add context">
			<IconPlus size={14} /> Add
		</Button>
	</div>
	{#if data.contextItems.length === 0}
		<div class="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
			No context for this project yet — attach conventions, skills, or repos that every issue here
			should carry.
		</div>
	{:else}
		<div class="space-y-4">
			{#if projectOnlyItems.length > 0}
				<ContextItemList items={projectOnlyItems} showScope={false} onselect={openContextEdit} />
			{/if}
			{#each stateGroups as group (group.label)}
				<div>
					<h3 class="text-muted-foreground mb-1.5 text-xs font-semibold">
						Only in state <span class="text-foreground">{group.label}</span>
					</h3>
					<ContextItemList items={group.items} showScope={false} onselect={openContextEdit} />
				</div>
			{/each}
		</div>
	{/if}
</div>

<AgentRoutingCard
	rules={data.routingRules}
	{activeStateIds}
	emptyMessage="No routing rule covers this project — its issues will not dispatch to agents."
/>

<div class="mb-3 flex items-center justify-between">
	<h2 class="text-sm font-semibold">Issues</h2>
	<div class="flex items-center gap-4">
		<!-- Ready implies not-done, so "Show done" parks while it is on. -->
		<label
			class="text-muted-foreground flex items-center gap-2 text-sm {data.ready ? 'opacity-50' : ''}"
			title={data.ready ? 'Ready issues are never done' : undefined}
		>
			<input
				type="checkbox"
				checked={data.showDone && !data.ready}
				disabled={data.ready}
				onchange={(e) => setFilter('done', e.currentTarget.checked)}
			/>
			Show done
		</label>
		<label class="text-muted-foreground flex items-center gap-2 text-sm">
			<input
				type="checkbox"
				checked={data.ready}
				onchange={(e) => setFilter('ready', e.currentTarget.checked)}
			/>
			Ready only
		</label>
	</div>
</div>

<IssueList
	issues={data.issues}
	showProject={false}
	emptyMessage={data.ready ? 'No ready issues in this project.' : 'No issues in this project yet.'}
/>

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
	projects={[data.project]}
	workflows={data.workflows}
	onsaved={invalidateAll}
/>

<!-- settings -->
<Modal bind:open={settingsOpen} title="Project settings">
	<form onsubmit={saveSettings} class="space-y-4">
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="settings-name">Name</label>
			<Input id="settings-name" bind:value={settingsName} required />
		</div>
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="settings-description">Description</label>
			<Textarea id="settings-description" bind:value={settingsDescription} rows={3} />
		</div>
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="settings-workflow">Default workflow</label>
			<Select id="settings-workflow" bind:value={settingsDefaultWorkflow}>
				<option value="">Standard (built-in)</option>
				{#each data.workflows.filter((w) => !w.is_system) as workflow (workflow.id)}
					<option value={workflow.id}>{workflow.name}</option>
				{/each}
			</Select>
		</div>
		<div class="flex items-center justify-between gap-2 pt-2">
			<Button
				type="button"
				variant="destructive"
				disabled={data.project.issue_count > 0}
				title={data.project.issue_count > 0 ? 'Projects with issues cannot be deleted' : undefined}
				onclick={deleteProject}
			>
				Delete project
			</Button>
			<div class="flex gap-2">
				<Button type="button" variant="ghost" onclick={() => (settingsOpen = false)}>Cancel</Button>
				<Button type="submit" disabled={savingSettings || !settingsName.trim()}>
					{savingSettings ? 'Saving…' : 'Save'}
				</Button>
			</div>
		</div>
	</form>
</Modal>
