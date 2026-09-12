<script lang="ts">
	import type { WorkflowPackageDocument } from '@tines/shared';
	import IconCheck from '@tabler/icons-svelte/icons/check';
	import WorkflowGraph from '$lib/components/WorkflowGraph.svelte';
	import PackageText from './PackageText.svelte';

	let {
		document,
		reviewed,
		onReview,
		onToken,
		onEdit
	}: {
		document: WorkflowPackageDocument;
		reviewed: Set<string>;
		onReview: (id: string, checked: boolean) => void;
		onToken: (id: string, trigger: HTMLElement) => void;
		onEdit: (recordId: string, field: string) => void;
	} = $props();

	const workflowByState = $derived.by(() => {
		const result = new Map<string, (typeof document.workflows)[number]>();
		for (const workflow of document.workflows)
			for (const state of workflow.states) result.set(state.id, workflow);
		return result;
	});
	const itemByState = $derived.by(() => {
		const result = new Map<string, typeof document.context>();
		for (const item of document.context)
			result.set(item.state_id, [...(result.get(item.state_id) ?? []), item]);
		return result;
	});
	function tokens(recordId: string, field: string) {
		return document.text_uses
			.filter((use) => use.target.record_id === recordId && use.target.field === field)
			.map((use) => ({ token: use.token, inputId: use.input_id }));
	}
</script>

<div class="space-y-8" data-testid="package-review">
	<section aria-labelledby="package-graph-title">
		<h2 id="package-graph-title" class="mb-3 text-lg font-semibold">Workflow graph and gates</h2>
		<div class="space-y-5">
			{#each document.workflows as workflow, index (workflow.id)}
				<article class="rounded-lg border p-4" id="review-{workflow.id}">
					<div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
						<h3 class="font-semibold">{workflow.name}</h3>
						<span class="text-muted-foreground text-xs"
							>{index === 0 ? 'Main workflow' : 'Required inheritance dependency'}</span
						>
					</div>
					{#if workflow.description}
						<PackageText
							text={workflow.description}
							tokens={tokens(workflow.id, 'description')}
							{onToken}
						/>
					{/if}
					<div class="mt-4 overflow-x-auto"><WorkflowGraph {workflow} /></div>
					<ul class="mt-4 space-y-2 text-sm">
						{#each workflow.transitions as transition (transition.id)}
							<li class="bg-muted/40 rounded-md p-2">
								<b>{transition.name}</b>: {workflow.states.find(
									(s) => s.id === transition.from_state_id
								)?.name} → {workflow.states.find((s) => s.id === transition.to_state_id)?.name}
								{#if transition.requires.length}
									<ul class="mt-1 list-disc pl-5 text-xs">
										{#each transition.requires as gate}<li>
												{gate.artifact} · {gate.type}{gate.content_type
													? ` · ${gate.content_type}`
													: ''} — {gate.description}
											</li>{/each}
									</ul>
								{:else}<span class="text-muted-foreground"> · no artifact gate</span>{/if}
							</li>
						{/each}
					</ul>
					<ul class="mt-4 space-y-1 text-xs">
						{#each workflow.states as state (state.id)}
							<li>
								<b>{state.name}</b>{#if state.inherits_from}
									inherits from <a
										class="text-primary underline"
										href="#review-{workflowByState.get(state.inherits_from.state_id)?.id}"
										>{workflowByState.get(state.inherits_from.state_id)?.name} › {workflowByState
											.get(state.inherits_from.state_id)
											?.states.find((s) => s.id === state.inherits_from?.state_id)?.name}</a
									>{:else}
									· local context only{/if}
							</li>
						{/each}
					</ul>
				</article>
			{/each}
		</div>
	</section>

	<section aria-labelledby="package-context-title">
		<h2 id="package-context-title" class="mb-1 text-lg font-semibold">Ordered state context</h2>
		<p class="text-muted-foreground mb-3 text-sm">
			Every entry below is bundled at its exact state scope. Inherited entries remain separate from
			local entries and keep document order.
		</p>
		<div class="space-y-5">
			{#each document.workflows as workflow}
				{#each workflow.states as state}
					{@const items = itemByState.get(state.id) ?? []}
					<article class="rounded-lg border p-4">
						<h3 class="font-semibold">{workflow.name} › {state.name}</h3>
						<p class="text-muted-foreground mb-3 text-xs">
							{state.inherits_from
								? 'Local entries below; inherited entries are shown under their owning dependency state above.'
								: 'Local entries in applied order.'}
						</p>
						{#if items.length === 0}<p class="text-muted-foreground text-sm">
								No local context.
							</p>{/if}
						<div class="space-y-4">
							{#each items as item (item.id)}
								<section class="min-w-0 border-l-2 pl-3" id="review-{item.id}">
									<div class="flex flex-wrap items-center justify-between gap-2">
										<h4 class="font-medium">
											{item.name} <span class="text-muted-foreground text-xs">· {item.kind}</span>
										</h4>
										{#if item.kind === 'prompt'}<button
												class="text-primary text-xs underline"
												type="button"
												onclick={() => onEdit(item.id, 'body')}>Edit candidate text</button
											>{/if}
									</div>
									{#if item.description}<p class="text-muted-foreground my-2 text-xs">
											{item.description}
										</p>{/if}
									{#if item.kind === 'prompt'}
										<PackageText text={item.body} tokens={tokens(item.id, 'body')} {onToken} />
									{:else if item.kind === 'skill'}
										{#each item.files as file (file.id)}
											<div class="mt-3">
												<div class="mb-1 flex justify-between gap-2 text-xs">
													<code>{file.path}</code><button
														class="text-primary underline"
														type="button"
														onclick={() => onEdit(file.id, 'content')}>Edit candidate text</button
													>
												</div>
												<PackageText
													text={file.content}
													tokens={tokens(file.id, 'content')}
													{onToken}
												/>
											</div>
										{/each}
										<label class="mt-3 flex min-h-10 items-center gap-2 text-sm"
											><input
												type="checkbox"
												checked={reviewed.has(item.id)}
												onchange={(e) => onReview(item.id, e.currentTarget.checked)}
											/>
											<IconCheck size={15} /> I reviewed every file in this required skill</label
										>
									{:else}
										<dl class="mt-2 grid min-w-0 grid-cols-[5rem_1fr] gap-1 text-xs">
											<dt>URL</dt>
											<dd class="font-mono break-all">{item.repo_url}</dd>
											<dt>Branch</dt>
											<dd>{item.repo_branch ?? 'default'}</dd>
											<dt>Directory</dt>
											<dd>{item.repo_dir ?? 'repository root'}</dd>
										</dl>
										<p class="text-muted-foreground mt-2 text-xs">
											Declaration only. Tines does not fetch this repository.
										</p>
										<label class="mt-2 flex min-h-10 items-center gap-2 text-sm"
											><input
												type="checkbox"
												checked={reviewed.has(item.id)}
												onchange={(e) => onReview(item.id, e.currentTarget.checked)}
											/>
											<IconCheck size={15} /> I reviewed this required repository declaration</label
										>
									{/if}
								</section>
							{/each}
						</div>
					</article>
				{/each}
			{/each}
		</div>
	</section>

	<section class="grid gap-4 md:grid-cols-2" aria-label="Package prerequisites and automation">
		<div class="rounded-lg border p-4">
			<h2 class="font-semibold">Destination prerequisites</h2>
			{#if document.inputs.length}<ul class="mt-2 space-y-1 text-sm">
					{#each document.inputs as input}<li>
							<code>{input.key}</code> · {input.type} · {input.required ? 'required' : 'optional'} · default
							{input.default ?? 'none'}
						</li>{/each}
				</ul>{:else}<p class="text-muted-foreground mt-2 text-sm">
					No destination inputs declared.
				</p>{/if}
		</div>
		<div class="rounded-lg border p-4">
			<h2 class="font-semibold">Explicitly selected automation</h2>
			<p class="mt-2 text-sm">
				{document.schedules.length} schedule{document.schedules.length === 1 ? '' : 's'} and {document
					.routing.length} tier preference{document.routing.length === 1 ? '' : 's'} selected.
			</p>
			{#each document.schedules as schedule}<p class="mt-2 text-xs">
					<b>{schedule.name}</b> · {schedule.timezone} · {schedule.recurrence.kind === 'cron'
						? schedule.recurrence.cron
						: schedule.recurrence.preset.kind} · installs paused
				</p>{/each}{#each document.routing as route}<p class="mt-2 text-xs">
					<b>{route.tier}</b> for {workflowByState
						.get(route.scope.state_id)
						?.states.find((state) => state.id === route.scope.state_id)?.name}{route.scope.project
						? ' in destination project'
						: ' without a project'}
				</p>{/each}
		</div>
	</section>
</div>
