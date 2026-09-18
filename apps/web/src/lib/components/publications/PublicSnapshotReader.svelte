<script lang="ts">
	import type { WorkflowPackageDocument } from '@tines/shared';
	import WorkflowGraph from '$lib/components/WorkflowGraph.svelte';
	import PublicTextSnippet from './PublicTextSnippet.svelte';

	let { document }: { document: WorkflowPackageDocument } = $props();
	const main = $derived(document.workflows.find((item) => item.id === document.main_workflow_id)!);
	function workflowName(id: string) {
		return document.workflows.find((item) => item.id === id)?.name ?? id;
	}
	function stateName(id: string) {
		return (
			document.workflows.flatMap((item) => item.states).find((item) => item.id === id)?.name ?? id
		);
	}
</script>

<div class="min-w-0 space-y-6" data-link-mode="inert">
	<section aria-labelledby="reader-summary">
		<h3 id="reader-summary" class="text-lg font-semibold">{main.name}</h3>
		<PublicTextSnippet source={main.description || 'No description provided.'} linkMode="inert" />
	</section>
	<section aria-labelledby="reader-workflows">
		<h3 id="reader-workflows" class="font-semibold">Workflows, states and gates</h3>
		{#each document.workflows as workflow}<article class="mt-3 min-w-0 rounded-md border p-3">
				<h4 class="font-semibold break-words">{workflow.name}</h4>
				<div class="mt-3 overflow-x-auto"><WorkflowGraph {workflow} /></div>
				<ul class="mt-3 flex flex-wrap gap-2 text-xs">
					{#each workflow.states as state}<li class="bg-muted rounded px-2 py-1 break-words">
							{state.name} · {state.category}{state.inherits_from
								? ` · inherits ${stateName(state.inherits_from.state_id)}`
								: ''}
						</li>{/each}
				</ul>
				<ul class="mt-3 space-y-2 text-sm">
					{#each workflow.transitions as transition}<li>
							<b>{transition.name}</b> — {transition.requires.length
								? transition.requires.map((gate) => `${gate.artifact} (${gate.type})`).join(', ')
								: 'no artifact gate'}
						</li>{/each}
				</ul>
			</article>{/each}
	</section>
	<section aria-labelledby="reader-context">
		<h3 id="reader-context" class="font-semibold">Complete instructions and declarations</h3>
		{#each document.context as item}<article class="mt-3 min-w-0 rounded-md border p-3 break-words">
				<h4 class="font-semibold">{item.name} · {item.kind}</h4>
				{#if item.description}<PublicTextSnippet source={item.description} linkMode="inert" />{/if}
				{#if item.kind === 'prompt'}<PublicTextSnippet source={item.body} linkMode="inert" />
				{:else if item.kind === 'skill'}{#each item.files as file}<section class="mt-3">
							<h5 class="font-mono text-sm">{file.path}</h5>
							<PublicTextSnippet source={file.content} linkMode="inert" />
						</section>{/each}
				{:else}<dl class="mt-2 grid grid-cols-[5rem_minmax(0,1fr)] text-sm">
						<dt>URL</dt>
						<dd class="break-all">{item.repo_url}</dd>
						<dt>Branch</dt>
						<dd>{item.repo_branch ?? 'default'}</dd>
						<dt>Directory</dt>
						<dd>{item.repo_dir ?? 'root'}</dd>
					</dl>{/if}
			</article>{/each}
	</section>
	<section class="grid gap-4 md:grid-cols-2" aria-label="Inputs and automation">
		<article class="rounded-md border p-3">
			<h3 class="font-semibold">Inputs</h3>
			<ul class="mt-2 space-y-2 text-sm">
				{#each document.inputs as input}<li>
						<code>{input.key}</code> · {input.type} · {input.required ? 'required' : 'optional'}<br
						/>{input.label}{input.description ? ` — ${input.description}` : ''}<br /><span
							class="text-muted-foreground">Default: {input.default ?? 'none'}</span
						>
					</li>{/each}
			</ul>
		</article>
		<article class="rounded-md border p-3">
			<h3 class="font-semibold">Selected automation</h3>
			<ul class="mt-2 space-y-2 text-sm">
				{#each document.schedules as schedule}<li>
						<b>{schedule.name}</b> · {schedule.recurrence.kind === 'preset'
							? schedule.recurrence.preset
							: schedule.recurrence.cron} · {schedule.timezone}<br />Workflow: {workflowName(
							schedule.workflow.workflow_id
						)}<br />Title: {schedule.title_template}<br />Description: {schedule.description_template}
					</li>{/each}{#if !document.schedules.length}<li>No schedules selected.</li>{/if}
			</ul>
			<h4 class="mt-3 font-semibold">Routing</h4>
			<ul class="text-sm">
				{#each document.routing as route}<li>
						{stateName(route.scope.state_id)} · {route.tier}
					</li>{/each}{#if !document.routing.length}<li>No routing preferences selected.</li>{/if}
			</ul>
		</article>
	</section>
	<p class="text-muted-foreground text-xs">
		Document {document.digest}. External destinations are shown as text; no links or actions are
		active.
	</p>
</div>
