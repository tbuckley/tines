<script lang="ts">
	import { scanPlaceholders, type PackAdds, type PackModel, type PackReview } from '@tines/shared';
	import IconAlertTriangle from '@tabler/icons-svelte/icons/alert-triangle';
	import Markdown from '$lib/components/Markdown.svelte';
	import { Input } from '$lib/components/ui/input/index.js';
	import PackInputsForm from './PackInputsForm.svelte';
	import { previewText, type InputDraft } from '$lib/packs-client';

	let {
		review,
		drafts = $bindable(),
		workflowOptions,
		schedules = $bindable({}),
		mapping = $bindable({})
	}: {
		review: PackReview;
		drafts: Record<string, InputDraft>;
		workflowOptions: { value: string; label: string }[];
		/** Install: suggested schedule key → { checked, timezone }. */
		schedules?: Record<string, { checked: boolean; timezone: string }>;
		/** Replace: removed state id → target ref. */
		mapping?: Record<string, string>;
	} = $props();

	const model = $derived(review.model);
	const workflowLabel = (ref: string) =>
		workflowOptions.find((o) => o.value === ref)?.label ?? ref.replace(/^pack:/, '');
	const render = (text: string) => previewText(text, review.inputs, drafts, workflowLabel);

	/** Whether every input a text reads has a value in the form. */
	function satisfied(text: string): boolean {
		return scanPlaceholders(text).every((name) => {
			const view = review.inputs.find((v) => v.name === name);
			const d = drafts[name];
			if (!view || !d) return false;
			if (view.decl.type === 'text') return d.text !== '' || view.decl.required === false;
			if (view.decl.type === 'repo') return d.repo_url.trim() !== '';
			if (view.decl.type === 'workflow') return d.workflow !== '';
			return false;
		});
	}

	function reachLabel(
		item: { reach: string; workflow: string | null; state: string | null },
		m: PackModel
	) {
		if (item.reach === 'project') return 'Every issue in this project';
		if (item.reach === 'pack') return "Issues in any of this pack's workflows";
		const wf = m.workflows.find((w) => w.key === item.workflow);
		if (item.reach === 'workflow') return `Workflow ${wf?.name ?? item.workflow}`;
		const st = wf?.states.find((s) => s.key === item.state);
		return `State ${wf?.name ?? item.workflow} / ${st?.name ?? item.state}`;
	}

	/** A plain line diff: lines only in the old file, then lines only in the new. */
	function lineDiff(before: string | undefined, after: string | undefined): string {
		const a = (before ?? '').split('\n');
		const b = (after ?? '').split('\n');
		const inB = new Set(b);
		const inA = new Set(a);
		const out: string[] = [];
		let i = 0;
		let j = 0;
		while (i < a.length || j < b.length) {
			if (i < a.length && j < b.length && a[i] === b[j]) {
				out.push(`  ${a[i]}`);
				i++;
				j++;
			} else if (i < a.length && !inB.has(a[i])) out.push(`- ${a[i++]}`);
			else if (j < b.length && !inA.has(b[j])) out.push(`+ ${b[j++]}`);
			else if (i < a.length) out.push(`- ${a[i++]}`);
			else out.push(`+ ${b[j++]}`);
		}
		return out.join('\n');
	}

	const adds = $derived<PackAdds | null>(
		review.action === 'replace' ? (review.adds_changed ?? null) : review.adds
	);
	const addsEmpty = $derived(
		!adds ||
			(adds.workflows.length === 0 &&
				adds.project_items.length === 0 &&
				adds.env.length === 0 &&
				adds.fixed_repos.length === 0 &&
				adds.wide_states.length === 0 &&
				adds.schedules.length === 0)
	);
</script>

{#if review.errors.length}
	<section
		class="rounded-lg border border-red-500/40 bg-red-500/5 p-4"
		aria-labelledby="pack-errors"
	>
		<h2 id="pack-errors" class="font-semibold text-red-700 dark:text-red-300">
			This pack has {review.errors.length} error{review.errors.length === 1 ? '' : 's'}
		</h2>
		<ul class="mt-2 space-y-1 text-sm">
			{#each review.errors as issue, i (i)}
				<li>
					{#if issue.path}<code class="text-xs">{issue.path}</code>:{/if}
					{issue.message}
				</li>
			{/each}
		</ul>
	</section>
{/if}
{#if review.warnings.length}
	<section class="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
		<h2 class="text-sm font-semibold">Warnings</h2>
		<ul class="mt-2 space-y-1 text-sm">
			{#each review.warnings as issue, i (i)}
				<li>
					{#if issue.path}<code class="text-xs">{issue.path}</code>:{/if}
					{issue.message}
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#if model}
	{#if review.action === 'install' && model.readme}
		<section class="mt-6 rounded-lg border p-4" aria-label="README">
			<Markdown source={model.readme} inertImages />
		</section>
	{:else if review.action === 'replace'}
		<section class="mt-6 rounded-lg border p-4" aria-labelledby="pack-changelog">
			<h2 id="pack-changelog" class="font-semibold">What's new</h2>
			{#if review.changelog}
				<Markdown class="mt-2" source={review.changelog} inertImages />
			{:else}
				<p class="text-muted-foreground mt-2 text-sm">This version has no changelog.</p>
			{/if}
		</section>
		<section class="mt-4 rounded-lg border p-4" aria-labelledby="pack-files">
			<h2 id="pack-files" class="font-semibold">Changed files</h2>
			{#if !review.files?.length}
				<p class="text-muted-foreground mt-2 text-sm">No file changes.</p>
			{:else}
				<ul class="mt-2 space-y-1">
					{#each review.files as file (file.path)}
						<li>
							<details>
								<summary class="cursor-pointer text-sm">
									<span
										class={file.change === 'added'
											? 'text-emerald-700 dark:text-emerald-300'
											: file.change === 'removed'
												? 'text-red-700 dark:text-red-300'
												: ''}>{file.change}</span
									>
									<code class="ml-1 text-xs">{file.path}</code>
								</summary>
								<pre class="bg-muted mt-1 max-h-80 overflow-auto rounded p-2 text-xs">{lineDiff(
										file.before,
										file.after
									)}</pre>
							</details>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}

	<section class="mt-4 rounded-lg border p-4" aria-labelledby="pack-adds">
		<h2 id="pack-adds" class="font-semibold">
			{review.action === 'install' ? 'What this pack adds' : 'What changes in what the pack adds'}
		</h2>
		{#if adds && !addsEmpty}
			<dl class="mt-3 space-y-3 text-sm">
				{#if adds.workflows.length}
					<div>
						<dt class="font-medium">Workflows</dt>
						<dd>
							<ul class="mt-1 space-y-0.5">
								{#each adds.workflows as w (w.key)}
									<li>
										{w.name}
										<span class="text-muted-foreground"
											>— {w.states.map((s) => s.name).join(' → ')}</span
										>
									</li>
								{/each}
							</ul>
						</dd>
					</div>
				{/if}
				{#if adds.project_items.length}
					<div>
						<dt class="font-medium">Applies to every issue in this project</dt>
						<dd class="text-muted-foreground mt-1">
							{adds.project_items.map((i) => `${i.kind} “${i.name}”`).join(', ')}
						</dd>
					</div>
				{/if}
				{#if adds.env.length}
					<div>
						<dt class="font-medium">Environment variables</dt>
						<dd>
							<ul class="mt-1 space-y-0.5">
								{#each adds.env as e (e.reach + e.name)}
									<li>
										<code class="text-xs">{e.name}</code>
										{#if e.input}<span class="text-muted-foreground">from input {e.input}</span>
										{:else}= <code class="text-xs">{e.value}</code>{/if}
										<span class="text-muted-foreground text-xs">({e.reach})</span>
									</li>
								{/each}
							</ul>
						</dd>
					</div>
				{/if}
				{#if adds.fixed_repos.length}
					<div>
						<dt class="font-medium">Repositories checked out</dt>
						<dd>
							<ul class="mt-1 space-y-0.5">
								{#each adds.fixed_repos as r (r.name)}
									<li><code class="text-xs">{r.url}</code>{r.branch ? ` @ ${r.branch}` : ''}</li>
								{/each}
							</ul>
						</dd>
					</div>
				{/if}
				{#if adds.wide_states.length}
					<div>
						<dt class="font-medium">States whose agents reach past their own issue</dt>
						<dd>
							<ul class="mt-1 space-y-0.5">
								{#each adds.wide_states as s (s.workflow + s.state)}
									<li class="flex items-center gap-1">
										{#if s.run_scope === 'organization'}
											<IconAlertTriangle size={14} class="text-red-600" aria-hidden="true" />
										{/if}
										{s.workflow} / {s.state}:
										{s.run_scope === 'organization'
											? 'can edit shared workflows, labels and context (high risk)'
											: 'any issue in this project'}
									</li>
								{/each}
							</ul>
						</dd>
					</div>
				{/if}
				{#if adds.schedules.length}
					<div>
						<dt class="font-medium">Suggested schedules</dt>
						<dd class="text-muted-foreground mt-1">
							{adds.schedules.map((s) => s.name).join(', ')}
						</dd>
					</div>
				{/if}
			</dl>
		{:else}
			<p class="text-muted-foreground mt-2 text-sm">Nothing new.</p>
		{/if}
	</section>

	{#if review.replacements.length}
		<section class="mt-4 rounded-lg border p-4" aria-labelledby="pack-replacements">
			<h2 id="pack-replacements" class="font-semibold">Replacements</h2>
			<ul class="mt-2 space-y-1 text-sm">
				{#each review.replacements as r (r.item_id)}
					<li>
						{r.kind} <code class="text-xs">{r.name}</code> ({r.scope_label})
						<span class="text-muted-foreground">
							— {r.direction === 'pack_overrides' ? 'the pack overrides it' : 'overrides the pack'}
						</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<section class="mt-4 rounded-lg border p-4" aria-labelledby="pack-inputs">
		<h2 id="pack-inputs" class="font-semibold">Inputs</h2>
		<p class="text-muted-foreground mb-3 text-sm">
			Missing values do not block this; the pack shows <em>needs setup</em> and runs that need a missing
			value wait.
		</p>
		<PackInputsForm views={review.inputs} bind:drafts {workflowOptions} />
	</section>

	{#if review.action === 'install' && model.schedules.length}
		<section class="mt-4 rounded-lg border p-4" aria-labelledby="pack-schedules">
			<h2 id="pack-schedules" class="font-semibold">Schedules</h2>
			<p class="text-muted-foreground text-sm">A checked schedule is created enabled.</p>
			<ul class="mt-3 space-y-3">
				{#each model.schedules as s (s.key)}
					{@const ok = satisfied(s.title) && satisfied(s.description)}
					<li class="flex flex-wrap items-center gap-3 text-sm">
						<label class="flex items-center gap-2">
							<input type="checkbox" disabled={!ok} bind:checked={schedules[s.key].checked} />
							{s.name}
						</label>
						<Input
							class="w-48"
							aria-label="{s.name} timezone"
							bind:value={schedules[s.key].timezone}
						/>
						{#if !ok}<span class="text-muted-foreground text-xs">Fill its inputs first</span>{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if review.action === 'replace' && review.state_mapping?.length}
		<section class="mt-4 rounded-lg border p-4" aria-labelledby="pack-mapping">
			<h2 id="pack-mapping" class="font-semibold">State mapping</h2>
			<p class="text-muted-foreground text-sm">
				These states are removed. Their issues, project additions and schedules move to the state
				you choose.
			</p>
			<ul class="mt-3 space-y-3">
				{#each review.state_mapping as row (row.state_id)}
					<li class="text-sm">
						<label for="map-{row.state_id}" class="font-medium"
							>{row.workflow_name} / {row.state_name}</label
						>
						<span class="text-muted-foreground"
							>— {row.issues} issue{row.issues === 1 ? '' : 's'}, {row.additions} addition{row.additions ===
							1
								? ''
								: 's'}, {row.schedules} schedule{row.schedules === 1 ? '' : 's'}</span
						>
						<select
							id="map-{row.state_id}"
							class="border-input dark:bg-input/30 mt-1 h-9 w-full rounded-md border bg-transparent px-3 text-sm"
							bind:value={mapping[row.state_id]}
						>
							<option value="">Choose a state…</option>
							{#each review.mapping_targets ?? [] as t (t.ref)}
								<option value={t.ref}>{t.label}</option>
							{/each}
						</select>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<section class="mt-4 rounded-lg border p-4" aria-labelledby="pack-text">
		<h2 id="pack-text" class="font-semibold">Prompts and skills</h2>
		<p class="text-muted-foreground text-sm">
			Shown as an agent will read them, with the values above.
		</p>
		<ul class="mt-3 space-y-1">
			{#each model.prompts as p (p.reach + p.workflow + p.state + p.name)}
				<li>
					<details>
						<summary class="cursor-pointer text-sm">
							Prompt <code class="text-xs">{p.name}</code>
							<span class="text-muted-foreground text-xs">— {reachLabel(p, model)}</span>
						</summary>
						<Markdown
							class="bg-muted/40 mt-1 rounded p-3 text-sm"
							source={render(p.body)}
							inertImages
						/>
					</details>
				</li>
			{/each}
			{#each model.skills as s (s.reach + s.workflow + s.state + s.name)}
				<li>
					<details>
						<summary class="cursor-pointer text-sm">
							Skill <code class="text-xs">{s.name}</code>
							<span class="text-muted-foreground text-xs">— {reachLabel(s, model)}</span>
						</summary>
						{#each s.files as f (f.path)}
							<p class="mt-2 text-xs font-medium"><code>{f.path}</code></p>
							<pre
								class="bg-muted mt-1 max-h-80 overflow-auto rounded p-2 text-xs">{f.path.endsWith(
									'.md'
								)
									? render(f.content)
									: f.content}</pre>
						{/each}
					</details>
				</li>
			{/each}
		</ul>
	</section>
{/if}
