<script lang="ts">
	import { untrack } from 'svelte';
	import type { StageStats, StageStatsReport, SentBackDrilldown as Evidence } from '@tines/shared';
	import { shareLabel } from '@tines/shared';
	import { api } from '$lib/api';
	import { comparisonText, workflowHref } from '$lib/stage-stats-view';
	import Modal from './Modal.svelte';
	import { containDialogTab } from '$lib/dialog-focus';
	let {
		open,
		stage,
		report,
		project,
		onclose
	}: {
		open: boolean;
		stage: StageStats;
		report: StageStatsReport;
		project: string | null;
		onclose: () => void;
	} = $props();
	let data = $state<Evidence | null>(null),
		loading = $state(false),
		error = $state('');
	let requestToken = 0;
	const date = (n: number) => new Date(n).toLocaleString();
	async function load() {
		const token = ++requestToken;
		const query = {
			state: stage.state_id,
			project: project ?? undefined,
			window: `${report.window.ms / 3600000}h`,
			until: report.window.until
		};
		loading = true;
		error = '';
		data = null;
		try {
			const result = await api.getSupervisorSentBack(query);
			if (token === requestToken) data = result;
		} catch (err) {
			if (token === requestToken)
				error = err instanceof Error ? err.message : 'Could not load send-back evidence.';
		} finally {
			if (token === requestToken) loading = false;
		}
	}
	$effect(() => {
		const active = open;
		stage.state_id;
		report.window.until;
		project;
		if (active) untrack(() => void load());
		return () => {
			requestToken++;
		};
	});
	function close() {
		requestToken++;
		onclose();
	}
</script>

<svelte:window
	onkeydown={(event) => {
		if (open) containDialogTab(event, '[data-sent-back-content]');
	}}
/>
<Modal {open} onclose={close} title="Send-back evidence" size="xl">
	<div data-sent-back-content class="space-y-4 text-sm break-words">
		<div>
			<h3 class="font-semibold">{stage.state_name}</h3>
			<p class="text-muted-foreground text-xs">{stage.workflow_name}</p>
			<p class="mt-2 text-lg font-semibold">
				{stage.current.sent_back.count} of {stage.current.exits} exits · {stage.current.sent_back
					.share === null
					? 'No exits'
					: shareLabel(stage.current.sent_back.share)}
			</p>
			<p class="text-muted-foreground text-xs">
				{comparisonText(
					stage.current.sent_back.share,
					stage.previous?.sent_back.share,
					'share',
					report.previous !== null
				)}
			</p>
			<p class="mt-2">
				{stage.current.sent_back.agent} by agents · {stage.current.sent_back.human} by humans
			</p>
			<p class="text-muted-foreground text-xs">
				{date(report.window.since)} → {date(report.window.until)}
			</p>
			<a class="inline-flex min-h-11 items-center underline" href={workflowHref(stage)}
				>Edit current stage prompt</a
			>
		</div>
		{#if loading}<p role="status">Loading send-back evidence…</p>{:else if error}<div role="alert">
				<p>Could not load send-back evidence: {error}</p>
				<button class="min-h-11 underline" onclick={() => void load()}>Retry</button>
			</div>{:else if data}
			<p class="text-muted-foreground text-xs">
				Each item is a send-back event; one issue may appear more than once. Prompt versions
				identify history, not stored content snapshots.
			</p>
			{#if !data.items.length}<p>No send-back events in this window.</p>{/if}
			{#each data.items as item (item.issue.id + item.transitioned_at)}
				{@const href = `/issues/${encodeURIComponent(item.issue.project_name)}/${item.issue.number}`}
				<article class="space-y-2 rounded-lg border p-3">
					<a class="inline-block min-h-11 font-medium underline" {href}
						>{item.issue.project_name}/{item.issue.number} — {item.issue.title}</a
					>
					<p>Sent to {item.to_state_name} · {date(item.transitioned_at)}</p>
					<p>
						{item.actor.user_name} · {item.actor.run
							? 'Agent'
							: 'Human'}{#if item.actor.run?.runner_name}
							via {item.actor.run.runner_name}{/if}
					</p>
					{#if item.comment}<div>
							<a class="text-xs underline" href={`${href}#comment-${item.comment.id}`}
								>Related comment before transition</a
							>
							<p class="mt-1 whitespace-pre-wrap">{item.comment.excerpt}</p>
						</div>{:else}<p class="text-muted-foreground">No related comment</p>{/if}
					{#if item.prompt_version !== null}<p>
							instructions · v{item.prompt_version} at the time{item.prompt_context_id !==
							data.prompt?.context_id
								? ' · historical item'
								: ''}
						</p>{:else}<p class="text-muted-foreground">Prompt version unavailable</p>{/if}
					{#if item.prompt_context_id}<details>
							<summary class="min-h-11 cursor-pointer text-xs">Historical prompt context ID</summary
							><code class="text-xs break-all select-all">{item.prompt_context_id}</code>
						</details>{/if}
				</article>
			{/each}
		{/if}
	</div>
</Modal>
