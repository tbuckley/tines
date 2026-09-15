<script lang="ts">
	import IconChevronDown from '@tabler/icons-svelte/icons/chevron-down';
	import { ApiError, type Project, type StageStats, type StageStatsReport } from '@tines/shared';
	import { untrack } from 'svelte';
	import { api } from '$lib/api';
	import SentBackDrilldown from './SentBackDrilldown.svelte';
	import StageStatsBoard from './StageStatsBoard.svelte';
	import { Select } from './ui/select/index.js';

	let {
		projects,
		boardProject,
		boardProjectName,
		onproject,
		oncapacity
	}: {
		projects: Project[];
		boardProject: string | null;
		boardProjectName: string | null;
		onproject: (project: string) => void;
		oncapacity: (stateId: string) => void;
	} = $props();

	type Status = 'idle' | 'loading' | 'ready' | 'error';
	type Envelope = { projectKey: string; report: StageStatsReport };
	type Evidence = {
		stage: StageStats;
		report: StageStatsReport;
		project: string | null;
	};
	let open = $state(false);
	let status = $state<Status>('idle');
	let envelope = $state<Envelope | null>(null);
	let error = $state<string | null>(null);
	let evidence = $state<Evidence | null>(null);
	let generation = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let committedProjectKey = '';
	const projectKey = $derived(boardProject ?? '');
	const report = $derived(envelope?.projectKey === projectKey ? envelope.report : null);
	const missingSelectedProject = $derived(
		boardProject !== null && !projects.some((project) => project.id === boardProject)
	);

	function clearTimer() {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	}

	function invalidateRequest() {
		generation++;
		clearTimer();
		if (status === 'loading') status = 'idle';
	}

	function errorMessage(value: unknown) {
		return value instanceof ApiError || value instanceof Error
			? value.message
			: 'Unable to load weekly statistics.';
	}

	async function load() {
		if (!open || status === 'loading' || report) return;
		const id = ++generation;
		const capturedProjectKey = projectKey;
		status = 'loading';
		error = null;
		try {
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error('The state analysis request timed out.')),
					30_000
				);
			});
			const next = await Promise.race([
				api.getSupervisorStats({
					project: capturedProjectKey || undefined,
					window: '7d',
					compare: 'previous'
				}),
				timeout
			]);
			if (id !== generation || !open || capturedProjectKey !== projectKey) return;
			envelope = { projectKey: capturedProjectKey, report: next };
			status = 'ready';
		} catch (value) {
			if (id !== generation || !open || capturedProjectKey !== projectKey) return;
			error = errorMessage(value);
			status = 'error';
		} finally {
			if (id === generation) clearTimer();
		}
	}

	function toggle(next: boolean) {
		if (next === open) return;
		open = next;
		if (!open) {
			invalidateRequest();
			evidence = null;
			return;
		}
		void load();
	}

	function retry() {
		if (status === 'loading') return;
		status = 'idle';
		void load();
	}

	function openEvidence(stage: StageStats) {
		if (!report) return;
		evidence = { stage, report, project: boardProject };
	}

	$effect(() => {
		const nextProjectKey = projectKey;
		if (nextProjectKey === committedProjectKey) return;
		committedProjectKey = nextProjectKey;
		invalidateRequest();
		envelope = null;
		error = null;
		evidence = null;
		if (open) untrack(() => void load());
	});

	$effect(() => () => invalidateRequest());
</script>

<details
	class="mb-10 min-w-0 rounded-lg border"
	{open}
	ontoggle={(event) => toggle(event.currentTarget.open)}
>
	<summary
		class="focus-visible:ring-ring flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
	>
		<span class="min-w-0">
			<strong class="block text-sm">State analysis · Last 7 days</strong>
			<span class="text-muted-foreground block text-xs">Weekly flow and send-back analysis</span>
		</span>
		<span class="shrink-0 transition-transform" class:rotate-180={open}>
			<IconChevronDown size={18} aria-hidden="true" />
		</span>
	</summary>
	<div class="min-w-0 border-t px-4 pt-4">
		<div class="mb-4 flex min-w-0 flex-wrap items-end justify-between gap-3">
			<label class="text-muted-foreground min-w-0 text-xs">
				<span class="mb-1 block">State project</span>
				<Select
					class="max-w-full"
					value={boardProject ?? ''}
					onchange={(event) => onproject(event.currentTarget.value)}
				>
					<option value="">All projects</option>
					{#if missingSelectedProject}<option value={boardProject!}
							>{boardProjectName ?? `Unavailable project (${boardProject})`}</option
						>{/if}
					{#each projects as project (project.id)}
						<option value={project.id}>{project.name}</option>
					{/each}
				</Select>
			</label>
			<p class="text-muted-foreground max-w-full text-xs">
				Uses Board project from Now. Independent of Spend filters.
			</p>
		</div>
		{#if status === 'loading'}
			<p class="mb-6 text-sm" role="status">Loading state analysis…</p>
		{:else if status === 'error'}
			<div class="mb-6 text-sm" role="alert">
				<p>Could not load state analysis. {error}</p>
				<button type="button" class="min-h-11 underline" onclick={retry}>Retry</button>
			</div>
		{:else if report}
			<StageStatsBoard {report} {boardProject} {oncapacity} onsentback={openEvidence} />
		{/if}
	</div>
</details>

{#if evidence}
	<SentBackDrilldown
		open={true}
		stage={evidence.stage}
		report={evidence.report}
		project={evidence.project}
		onclose={() => (evidence = null)}
	/>
{/if}
