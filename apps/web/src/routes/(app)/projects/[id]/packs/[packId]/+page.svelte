<script lang="ts">
	import { untrack } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import IconAlertTriangle from '@tabler/icons-svelte/icons/alert-triangle';
	import IconChevronLeft from '@tabler/icons-svelte/icons/chevron-left';
	import IconDownload from '@tabler/icons-svelte/icons/download';
	import IconRefresh from '@tabler/icons-svelte/icons/refresh';
	import type { ContextItem, PackDetail, PackInputDecl, PackRemovePreview } from '@tines/shared';
	import Markdown from '$lib/components/Markdown.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import PackInputsForm from '$lib/components/packs/PackInputsForm.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import {
		browserTimezone,
		draftFor,
		packApi,
		valueFromDraft,
		type InputDraft
	} from '$lib/packs-client';

	let { data } = $props();
	const pack = $derived(data.pack);
	const authored = $derived(pack.kind === 'authored');
	const base = $derived(`/api/v1/projects/${data.project.id}/packs/${pack.id}`);
	const editable = $derived(!data.project.archived);

	let busy = $state<string | null>(null);
	let message = $state<string | null>(null);
	let notice = $state<string | null>(null);

	async function act<T>(key: string, fn: () => Promise<T>, done?: string): Promise<T | null> {
		busy = key;
		message = null;
		notice = null;
		try {
			const out = await fn();
			await invalidateAll();
			if (done) notice = done;
			return out;
		} catch (e) {
			message = e instanceof Error ? e.message : 'Request failed';
			return null;
		} finally {
			busy = null;
		}
	}

	// --- Inputs
	const draftsOf = (inputs: typeof data.pack.inputs) =>
		Object.fromEntries(inputs.map((v) => [v.name, draftFor(v)]));
	// Filled before the first render (the form reads each input's draft), and
	// again whenever the pack reloads.
	let drafts = $state<Record<string, InputDraft>>(untrack(() => draftsOf(data.pack.inputs)));
	$effect.pre(() => {
		drafts = draftsOf(pack.inputs);
	});
	const workflowOptions = $derived([
		...pack.workflows.flatMap((w) =>
			w.states.map((s, i) => ({
				value: i === 0 ? `pack:${w.key}` : `pack:${w.key}/${s.key}`,
				label: i === 0 ? `${w.name} (this pack)` : `${w.name} (this pack), starting in ${s.name}`
			}))
		),
		...data.workflowOptions.filter((o) => !pack.workflows.some((w) => o.value.startsWith(w.id)))
	]);
	async function saveValues() {
		const values: Record<string, unknown> = {};
		const secrets: Record<string, string> = {};
		for (const view of pack.inputs) {
			const d = drafts[view.name];
			if (view.decl.type === 'secret') {
				if (d.secret) secrets[view.name] = d.secret;
				continue;
			}
			const v = valueFromDraft(view, d);
			if (v !== undefined) values[view.name] = v;
		}
		await act(
			'values',
			async () => {
				if (Object.keys(values).length) await packApi(`${base}/values`, 'PUT', { values });
				if (Object.keys(secrets).length) await packApi(`${base}/my-secrets`, 'PUT', { secrets });
			},
			'Saved. Changes apply from the next run.'
		);
	}

	// --- Authored: details and input declarations
	let editing = $state(false);
	let draftName = $state('');
	let draftDescription = $state('');
	let draftReadme = $state('');
	let draftChangelog = $state('');
	let draftInputs = $state('');
	function startEdit() {
		draftName = pack.name;
		draftDescription = pack.description;
		draftReadme = pack.readme ?? '';
		draftChangelog = pack.changelog ?? '';
		draftInputs = JSON.stringify(
			Object.fromEntries(pack.inputs.map((v) => [v.name, v.decl])),
			null,
			2
		);
		editing = true;
	}
	async function saveDetails() {
		let inputs: Record<string, PackInputDecl>;
		try {
			inputs = JSON.parse(draftInputs || '{}');
		} catch {
			message = 'Inputs must be valid JSON: { "name": { "type": "text", "description": "…" } }';
			return;
		}
		const ok = await act('details', () =>
			packApi(base, 'PATCH', {
				expected_revision: pack.revision,
				name: draftName,
				description: draftDescription,
				readme: draftReadme || null,
				changelog: draftChangelog || null,
				inputs
			})
		);
		if (ok) editing = false;
	}

	// --- Workflows
	let copyFrom = $state('');
	let moveFor = $state<{ to: string; from: string } | null>(null);
	let movePreview = $state<{
		from: { id: string; name: string };
		to: { id: string; name: string; states: { id: string; name: string }[] };
		states: {
			state_id: string;
			state_name: string;
			issues: number;
			schedules: number;
			suggested: string | null;
		}[];
	} | null>(null);
	let moveMapping = $state<Record<string, string>>({});
	async function copyWorkflow() {
		if (!copyFrom) return;
		const from = copyFrom;
		const out = await act('copy', () =>
			packApi<PackDetail & { skipped: { name: string; reason: string }[] }>(
				`${base}/workflows`,
				'POST',
				{
					copy_from: from
				}
			)
		);
		if (out) {
			copyFrom = '';
			const added = out.workflows.find((w) => !pack.workflows.some((p) => p.id === w.id));
			notice =
				out.skipped.length > 0
					? `Copied. Skipped: ${out.skipped.map((s) => `${s.name} (${s.reason})`).join('; ')}`
					: 'Copied into the pack.';
			if (added) await openMove(added.id, from);
		}
	}
	async function openMove(to: string, from: string) {
		moveFor = { to, from };
		movePreview = await packApi(
			`${base}/workflows/${to}/move-issues?from=${encodeURIComponent(from)}`
		);
		moveMapping = Object.fromEntries(
			movePreview!.states.map((s) => [s.state_id, s.suggested ?? ''])
		);
	}
	async function moveIssues() {
		if (!moveFor) return;
		const target = moveFor;
		const out = await act('move', () =>
			packApi<{ issues_moved: number; schedules_moved: number }>(
				`${base}/workflows/${target.to}/move-issues`,
				'POST',
				{ from_workflow_id: target.from, state_mapping: moveMapping }
			)
		);
		if (out) {
			notice = `Moved ${out.issues_moved} issue(s) and ${out.schedules_moved} schedule(s).`;
			moveFor = null;
			movePreview = null;
		}
	}

	// --- Context
	const reaches = [
		['project', 'Every issue in this project'],
		['pack', "Issues in any of this pack's workflows"],
		['workflow', 'One workflow'],
		['state', 'One state']
	] as const;
	function itemsAt(reach: string) {
		return pack.items.filter((i) => i.pack?.reach === reach);
	}
	function itemPlace(item: ContextItem): string {
		if (item.pack?.reach === 'workflow') return item.pack.workflow_name ?? '';
		if (item.pack?.reach === 'state')
			return `${item.scope.workflow_name ?? ''} / ${item.scope.workflow_state_name ?? ''}`;
		return '';
	}
	let newItem = $state({
		reach: 'project',
		target: '',
		kind: 'prompt',
		name: '',
		body: '',
		value: '',
		input: '',
		repo_url: '',
		repo_branch: ''
	});
	async function addItem(event: SubmitEvent) {
		event.preventDefault();
		const n = newItem;
		const ok = await act('item', () =>
			packApi(`${base}/items`, 'POST', {
				reach: n.reach,
				...(n.reach === 'workflow' ? { workflow_id: n.target } : {}),
				...(n.reach === 'state' ? { state_id: n.target } : {}),
				kind: n.kind,
				name: n.name,
				...(n.kind === 'prompt' ? { body: n.body } : {}),
				...(n.kind === 'env' ? (n.input ? { input: n.input } : { value: n.value }) : {}),
				...(n.kind === 'repo'
					? n.input
						? { input: n.input }
						: { repo_url: n.repo_url, repo_branch: n.repo_branch || null }
					: {})
			})
		);
		if (ok)
			newItem = {
				...newItem,
				name: '',
				body: '',
				value: '',
				input: '',
				repo_url: '',
				repo_branch: ''
			};
	}
	let moveItemId = $state('');
	async function moveItemIn() {
		const id = moveItemId;
		if (!id) return;
		const ok = await act('move-item', () => packApi(`${base}/items`, 'POST', { move_item_id: id }));
		if (ok) moveItemId = '';
	}
	let editingItem = $state<string | null>(null);
	let itemBody = $state('');
	async function saveItem(item: ContextItem) {
		const ok = await act('save-item', () =>
			packApi(`/api/v1/context/${item.id}`, 'PATCH', {
				body: itemBody,
				expected_version: item.version
			})
		);
		if (ok) editingItem = null;
	}
	async function deleteItem(item: ContextItem) {
		if (!confirm(`Delete ${item.kind} “${item.name}” from the pack?`)) return;
		await act('delete-item', () => packApi(`/api/v1/context/${item.id}`, 'DELETE'));
	}

	// --- Schedules
	let timezones = $state<Record<string, string>>({});
	let suggestFrom = $state('');
	async function setUp(key: string) {
		const tz = timezones[key] ?? browserTimezone();
		await act(
			`setup-${key}`,
			() => packApi(`${base}/schedules/${key}/set-up`, 'POST', { timezone: tz }),
			'Schedule created and enabled.'
		);
	}
	async function suggest() {
		const id = suggestFrom;
		if (!id) return;
		const ok = await act('suggest', () =>
			packApi(`${base}/schedules`, 'POST', { schedule_id: id })
		);
		if (ok) suggestFrom = '';
	}

	// --- Detach / remove
	let removing = $state(false);
	let removal = $state<PackRemovePreview | null>(null);
	async function openRemove() {
		removing = true;
		removal = await packApi<PackRemovePreview>(`${base}/remove-preview`);
	}
	async function remove() {
		const ok = await act('remove', () =>
			packApi(base, 'DELETE', { expected_revision: pack.revision })
		);
		if (ok) await goto(`/projects/${data.project.id}/packs`);
	}
	async function detach() {
		if (
			!confirm(
				'Detach this pack? It becomes an editable pack with a new id, and new versions of the original can no longer replace it.'
			)
		)
			return;
		await act('detach', () =>
			packApi(`${base}/detach`, 'POST', { expected_revision: pack.revision })
		);
	}
	let exportNote = $state<string | null>(null);
	async function exportPack() {
		// Authored packs take a new version on export when they changed: show it.
		const out = await act('export', () =>
			packApi<{ version: number; new_version: boolean; filename: string }>(`${base}/export`)
		);
		if (!out) return;
		exportNote = out.new_version
			? `Exported as version ${out.version}.`
			: `Version ${out.version}, unchanged.`;
		window.location.href = `${base}/export?format=zip`;
	}
</script>

<svelte:head><title>{pack.name} · Packs · Tines</title></svelte:head>

<div class="mx-auto max-w-4xl pb-16">
	<a
		class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
		href={`/projects/${data.project.id}/packs`}><IconChevronLeft size={16} />Packs</a
	>
	<div class="mt-5 flex flex-wrap items-start justify-between gap-3">
		<div class="min-w-0">
			<h1 class="text-2xl font-semibold">{pack.name}</h1>
			<p class="text-muted-foreground mt-1 text-sm">
				<span class="bg-muted rounded px-1.5 py-0.5 text-xs">{pack.kind}</span>
				<code class="ml-1 text-xs">{pack.pack_key}</code>
				{#if pack.version !== null}· v{pack.version}{:else}· not exported yet{/if}
				{#if pack.source?.kind === 'project'}· from {pack.source.project_name ??
						'a removed pack'}{/if}
				{#if pack.derived_from}· derived from <code class="text-xs">{pack.derived_from.id}</code
					>{pack.derived_from.version ? ` v${pack.derived_from.version}` : ''}{/if}
			</p>
			{#if pack.description}<p class="mt-2 max-w-2xl text-sm">{pack.description}</p>{/if}
		</div>
		<div class="flex flex-wrap gap-2">
			<PendingButton variant="outline" pending={busy === 'export'} onclick={exportPack}>
				<IconDownload size={16} /> Export
			</PendingButton>
			{#if editable}
				{#if pack.source?.kind === 'project' && pack.source.pack_id}
					<Button
						variant="outline"
						href={`/projects/${data.project.id}/packs/${pack.id}/replace?from=source`}
					>
						<IconRefresh size={16} /> Update from source
					</Button>
				{/if}
				<Button variant="outline" href={`/projects/${data.project.id}/packs/${pack.id}/replace`}
					>Replace</Button
				>
				{#if !authored}
					<PendingButton variant="outline" pending={busy === 'detach'} onclick={detach}
						>Detach</PendingButton
					>
				{/if}
				<Button variant="outline" onclick={openRemove}>Remove</Button>
			{/if}
		</div>
	</div>
	{#if exportNote}<p class="mt-2 text-sm" role="status">{exportNote}</p>{/if}
	{#if pack.newer_version_available}
		<p class="mt-4 rounded-md border border-sky-500/40 bg-sky-500/10 p-3 text-sm">
			The pack this was installed from has changed.
			<a
				class="underline"
				href={`/projects/${data.project.id}/packs/${pack.id}/replace?from=source`}
				>Review the update</a
			>.
		</p>
	{/if}
	{#if pack.needs_setup.length}
		<div
			class="mt-4 flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
			role="status"
		>
			<IconAlertTriangle size={18} class="mt-0.5 shrink-0" aria-hidden="true" />
			<div>
				<p class="font-medium">Needs setup</p>
				<p>
					Runs whose context needs these wait until they have a value:
					{pack.needs_setup
						.map((m) => `${m.input}${m.type === 'secret' ? ' (your secret)' : ''}`)
						.join(', ')}.
				</p>
			</div>
		</div>
	{/if}
	{#if message}<p class="mt-4 text-sm text-red-600" role="alert">{message}</p>{/if}
	{#if notice}<p class="mt-4 text-sm" role="status">{notice}</p>{/if}

	<!-- Inputs -->
	<section class="mt-6 rounded-lg border p-4" aria-labelledby="inputs-heading">
		<div class="flex items-center justify-between">
			<h2 id="inputs-heading" class="font-semibold">Inputs</h2>
		</div>
		<p class="text-muted-foreground mb-3 text-sm">
			This project's values. A change takes effect at the next run.
		</p>
		<PackInputsForm views={pack.inputs} bind:drafts {workflowOptions} />
		{#if pack.inputs.length && editable}
			<div class="mt-4 flex justify-end">
				<PendingButton pending={busy === 'values'} onclick={saveValues}>Save values</PendingButton>
			</div>
		{/if}
	</section>

	<!-- About -->
	<section class="mt-4 rounded-lg border p-4" aria-labelledby="about-heading">
		<div class="flex items-center justify-between">
			<h2 id="about-heading" class="font-semibold">About</h2>
			{#if authored && editable && !editing}
				<Button size="sm" variant="outline" onclick={startEdit}>Edit details</Button>
			{/if}
		</div>
		{#if editing}
			<div class="mt-3 space-y-3">
				<div>
					<label for="pd-name" class="text-sm font-medium">Name</label>
					<Input id="pd-name" class="mt-1" bind:value={draftName} />
				</div>
				<div>
					<label for="pd-desc" class="text-sm font-medium">Description</label>
					<Textarea id="pd-desc" class="mt-1" rows={2} bind:value={draftDescription} />
				</div>
				<div>
					<label for="pd-readme" class="text-sm font-medium">README</label>
					<Textarea
						id="pd-readme"
						class="mt-1 font-mono text-xs"
						rows={6}
						bind:value={draftReadme}
					/>
				</div>
				<div>
					<label for="pd-changelog" class="text-sm font-medium">CHANGELOG</label>
					<Textarea
						id="pd-changelog"
						class="mt-1 font-mono text-xs"
						rows={4}
						bind:value={draftChangelog}
					/>
				</div>
				<div>
					<label for="pd-inputs" class="text-sm font-medium">Input declarations (JSON)</label>
					<p class="text-muted-foreground text-xs">
						Each input is <code>text</code>, <code>secret</code>, <code>repo</code> or
						<code>workflow</code>, as in <code>pack.yaml</code>.
					</p>
					<Textarea
						id="pd-inputs"
						class="mt-1 font-mono text-xs"
						rows={8}
						bind:value={draftInputs}
					/>
				</div>
				<div class="flex justify-end gap-2">
					<Button variant="outline" onclick={() => (editing = false)}>Cancel</Button>
					<PendingButton pending={busy === 'details'} onclick={saveDetails}>Save</PendingButton>
				</div>
			</div>
		{:else if pack.readme}
			<Markdown class="mt-2" source={pack.readme} inertImages />
		{:else}
			<p class="text-muted-foreground mt-2 text-sm">No README.</p>
		{/if}
		{#if !editing && pack.changelog}
			<details class="mt-3">
				<summary class="cursor-pointer text-sm">Changelog</summary>
				<Markdown class="mt-2" source={pack.changelog} inertImages />
			</details>
		{/if}
	</section>

	<!-- Workflows -->
	<section class="mt-4 rounded-lg border p-4" aria-labelledby="workflows-heading">
		<h2 id="workflows-heading" class="font-semibold">Workflows</h2>
		{#if pack.workflows.length === 0}
			<p class="text-muted-foreground mt-2 text-sm">
				This pack has no workflows: everything in it applies project-wide.
			</p>
		{:else}
			<ul class="mt-2 space-y-2">
				{#each pack.workflows as wf (wf.id)}
					<li class="text-sm">
						<a class="font-medium underline-offset-4 hover:underline" href={`/workflows/${wf.id}`}
							>{wf.name}</a
						>
						<code class="text-muted-foreground ml-1 text-xs">{wf.key}</code>
						<span class="text-muted-foreground"
							>— {wf.states.map((s) => s.name).join(' → ')} · {wf.issue_count} issue{wf.issue_count ===
							1
								? ''
								: 's'}</span
						>
					</li>
				{/each}
			</ul>
		{/if}
		{#if authored && editable}
			<div class="mt-4 flex flex-wrap items-end gap-2">
				<div class="min-w-0 flex-1">
					<label for="copy-from" class="text-sm font-medium">Copy a workflow into the pack</label>
					<select
						id="copy-from"
						class="border-input dark:bg-input/30 mt-1 h-9 w-full rounded-md border bg-transparent px-3 text-sm"
						bind:value={copyFrom}
					>
						<option value="">Choose a workflow…</option>
						{#each data.copyable as w (w.id)}<option value={w.id}>{w.label}</option>{/each}
					</select>
				</div>
				<PendingButton pending={busy === 'copy'} disabled={!copyFrom} onclick={copyWorkflow}
					>Copy</PendingButton
				>
			</div>
			<p class="text-muted-foreground mt-1 text-xs">
				Brings its states, transitions, run scopes and the context on its states (not journals). To
				make a new workflow, create it in the workflow editor, then copy it in.
			</p>
		{/if}
	</section>

	<!-- Context -->
	<section class="mt-4 rounded-lg border p-4" aria-labelledby="context-heading">
		<h2 id="context-heading" class="font-semibold">Context</h2>
		<p class="text-muted-foreground text-sm">
			Shown as written, with placeholders. The issue's Context view shows them rendered.
		</p>
		{#each reaches as [reach, label] (reach)}
			{@const list = itemsAt(reach)}
			{#if list.length}
				<h3 class="mt-4 text-sm font-medium">{label}</h3>
				<ul class="mt-1 space-y-1">
					{#each list as item (item.id)}
						<li class="text-sm">
							<details>
								<summary class="cursor-pointer">
									{item.kind} <code class="text-xs">{item.name}</code>
									{#if itemPlace(item)}<span class="text-muted-foreground text-xs"
											>— {itemPlace(item)}</span
										>{/if}
								</summary>
								<div class="mt-1 ml-4">
									{#if item.kind === 'prompt'}
										{#if editingItem === item.id}
											<Textarea class="font-mono text-xs" rows={8} bind:value={itemBody} />
											<div class="mt-2 flex gap-2">
												<PendingButton
													size="sm"
													pending={busy === 'save-item'}
													onclick={() => saveItem(item)}>Save</PendingButton
												>
												<Button size="sm" variant="outline" onclick={() => (editingItem = null)}
													>Cancel</Button
												>
											</div>
										{:else}
											<pre
												class="bg-muted max-h-72 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">{item.body}</pre>
										{/if}
									{:else if item.kind === 'env'}
										<p class="text-xs">
											{item.secret ? `secret — ${item.hint ?? ''}` : (item.value ?? '')}
										</p>
									{:else if item.kind === 'repo'}
										<p class="text-xs">
											{item.repo_url || 'from an input'}{item.repo_branch
												? ` @ ${item.repo_branch}`
												: ''}
										</p>
									{:else if item.kind === 'skill'}
										<p class="text-muted-foreground text-xs">
											{item.file_count ?? 0} file(s) — {item.description}
										</p>
									{/if}
									{#if authored && editable && editingItem !== item.id}
										<div class="mt-2 flex gap-2">
											{#if item.kind === 'prompt'}
												<Button
													size="sm"
													variant="outline"
													onclick={() => {
														editingItem = item.id;
														itemBody = item.body ?? '';
													}}>Edit</Button
												>
											{/if}
											<Button size="sm" variant="outline" onclick={() => deleteItem(item)}
												>Delete</Button
											>
										</div>
									{/if}
								</div>
							</details>
						</li>
					{/each}
				</ul>
			{/if}
		{/each}
		{#if pack.items.length === 0}
			<p class="text-muted-foreground mt-2 text-sm">No context items.</p>
		{/if}
		{#if pack.project_addition_count}
			<p class="text-muted-foreground mt-3 text-xs">
				This project also has {pack.project_addition_count} item(s) of its own on this pack's states.
				They are not part of the pack and survive a replace.
			</p>
		{/if}

		{#if authored && editable}
			<form class="mt-5 space-y-3 border-t pt-4" onsubmit={addItem}>
				<h3 class="text-sm font-medium">Add context</h3>
				<div class="grid gap-2 sm:grid-cols-3">
					<select
						aria-label="Where it applies"
						class="border-input dark:bg-input/30 h-9 rounded-md border bg-transparent px-3 text-sm"
						bind:value={newItem.reach}
					>
						{#each reaches as [reach, label] (reach)}<option value={reach}>{label}</option>{/each}
					</select>
					{#if newItem.reach === 'workflow' || newItem.reach === 'state'}
						<select
							aria-label="Which"
							class="border-input dark:bg-input/30 h-9 rounded-md border bg-transparent px-3 text-sm"
							bind:value={newItem.target}
						>
							<option value="">Choose…</option>
							{#each pack.workflows as wf (wf.id)}
								{#if newItem.reach === 'workflow'}
									<option value={wf.id}>{wf.name}</option>
								{:else}
									{#each wf.states as s (s.id)}<option value={s.id}>{wf.name} / {s.name}</option
										>{/each}
								{/if}
							{/each}
						</select>
					{/if}
					<select
						aria-label="Kind"
						class="border-input dark:bg-input/30 h-9 rounded-md border bg-transparent px-3 text-sm"
						bind:value={newItem.kind}
					>
						<option value="prompt">Prompt</option>
						<option value="env">Env variable</option>
						<option value="repo">Repo</option>
					</select>
				</div>
				<Input
					aria-label="Name"
					placeholder={newItem.kind === 'env' ? 'VARIABLE_NAME' : 'name'}
					bind:value={newItem.name}
					required
				/>
				{#if newItem.kind === 'prompt'}
					<Textarea
						aria-label="Prompt"
						class="font-mono text-xs"
						rows={5}
						placeholder={'Markdown. Use {{ inputs.<name> }} for an input value.'}
						bind:value={newItem.body}
					/>
				{:else}
					<div class="grid gap-2 sm:grid-cols-2">
						<select
							aria-label="Value from"
							class="border-input dark:bg-input/30 h-9 rounded-md border bg-transparent px-3 text-sm"
							bind:value={newItem.input}
						>
							<option value="">A fixed value</option>
							{#each pack.inputs.filter( (i) => (newItem.kind === 'env' ? i.decl.type === 'text' || i.decl.type === 'secret' : i.decl.type === 'repo') ) as i (i.name)}
								<option value={i.name}>Input {i.name}</option>
							{/each}
						</select>
						{#if !newItem.input}
							{#if newItem.kind === 'env'}
								<Input aria-label="Value" placeholder="value" bind:value={newItem.value} />
							{:else}
								<div class="flex gap-2">
									<Input
										aria-label="Repository URL"
										placeholder="https://github.com/…"
										bind:value={newItem.repo_url}
									/>
									<Input
										aria-label="Branch"
										class="w-28"
										placeholder="branch"
										bind:value={newItem.repo_branch}
									/>
								</div>
							{/if}
						{/if}
					</div>
				{/if}
				<div class="flex justify-end">
					<PendingButton type="submit" pending={busy === 'item'}>Add</PendingButton>
				</div>
			</form>
			{#if data.projectItems.length}
				<div class="mt-4 flex flex-wrap items-end gap-2 border-t pt-4">
					<div class="min-w-0 flex-1">
						<label for="move-item" class="text-sm font-medium"
							>Move one of this project's items into the pack</label
						>
						<select
							id="move-item"
							class="border-input dark:bg-input/30 mt-1 h-9 w-full rounded-md border bg-transparent px-3 text-sm"
							bind:value={moveItemId}
						>
							<option value="">Choose an item…</option>
							{#each data.projectItems as item (item.id)}<option value={item.id}
									>{item.kind} {item.name}</option
								>{/each}
						</select>
					</div>
					<PendingButton pending={busy === 'move-item'} disabled={!moveItemId} onclick={moveItemIn}
						>Move</PendingButton
					>
				</div>
			{/if}
			<p class="text-muted-foreground mt-3 text-xs">
				Skills are added from files: write them into the pack folder and <code
					>tines packs replace</code
				>.
			</p>
		{/if}
	</section>

	<!-- Suggested schedules -->
	<section class="mt-4 rounded-lg border p-4" aria-labelledby="schedules-heading">
		<h2 id="schedules-heading" class="font-semibold">Suggested schedules</h2>
		{#if pack.schedules.length === 0}
			<p class="text-muted-foreground mt-2 text-sm">None.</p>
		{:else}
			<ul class="mt-2 space-y-3">
				{#each pack.schedules as s (s.key)}
					<li class="text-sm">
						<div class="font-medium">{s.name}</div>
						<div class="text-muted-foreground text-xs">
							{s.recurrence_text} · workflow <code>{s.workflow_key}</code>
							{#if s.only_when_previous_closed}· only when the previous one is closed{/if}
						</div>
						{#if s.created_schedules.length}
							<div class="text-muted-foreground text-xs">
								Set up as {s.created_schedules.map((c) => `“${c.name}”`).join(', ')}
							</div>
						{/if}
						{#if editable}
							<div class="mt-2 flex flex-wrap items-center gap-2">
								<Input
									class="w-48"
									aria-label="Timezone for {s.name}"
									value={timezones[s.key] ?? browserTimezone()}
									oninput={(e) => (timezones[s.key] = (e.currentTarget as HTMLInputElement).value)}
								/>
								<PendingButton
									size="sm"
									pending={busy === `setup-${s.key}`}
									onclick={() => setUp(s.key)}>Set up</PendingButton
								>
								{#if authored}
									<Button
										size="sm"
										variant="outline"
										onclick={() =>
											act('unsuggest', () => packApi(`${base}/schedules/${s.key}`, 'DELETE'))}
										>Remove suggestion</Button
									>
								{/if}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#if authored && editable && data.schedules.some((s) => !s.pack_schedule_id)}
			<div class="mt-4 flex flex-wrap items-end gap-2 border-t pt-4">
				<div class="min-w-0 flex-1">
					<label for="suggest-from" class="text-sm font-medium"
						>Suggest one of this project's schedules</label
					>
					<select
						id="suggest-from"
						class="border-input dark:bg-input/30 mt-1 h-9 w-full rounded-md border bg-transparent px-3 text-sm"
						bind:value={suggestFrom}
					>
						<option value="">Choose a schedule…</option>
						{#each data.schedules.filter((s) => !s.pack_schedule_id) as s (s.id)}<option
								value={s.id}>{s.name}</option
							>{/each}
					</select>
				</div>
				<PendingButton pending={busy === 'suggest'} disabled={!suggestFrom} onclick={suggest}
					>Suggest in pack</PendingButton
				>
			</div>
		{/if}
	</section>
</div>

<Modal
	open={moveFor !== null}
	title="Move this project's issues onto the copy?"
	onclose={() => {
		moveFor = null;
		movePreview = null;
	}}
>
	{#if movePreview}
		<p class="text-sm">
			Issues and schedules in this project on “{movePreview.from.name}” can move to “{movePreview.to
				.name}”. Other projects keep using the original. Without this, the copy starts empty.
		</p>
		<ul class="mt-3 space-y-2">
			{#each movePreview.states.filter((s) => s.issues + s.schedules > 0) as s (s.state_id)}
				<li class="text-sm">
					<label for="mm-{s.state_id}"
						>{s.state_name} — {s.issues} issue(s), {s.schedules} schedule(s)</label
					>
					<select
						id="mm-{s.state_id}"
						class="border-input dark:bg-input/30 mt-1 h-9 w-full rounded-md border bg-transparent px-3 text-sm"
						bind:value={moveMapping[s.state_id]}
					>
						<option value="">Choose a state…</option>
						{#each movePreview.to.states as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
					</select>
				</li>
			{:else}
				<li class="text-muted-foreground text-sm">Nothing in this project uses it.</li>
			{/each}
		</ul>
		<div class="mt-4 flex justify-end gap-2">
			<Button
				variant="outline"
				onclick={() => {
					moveFor = null;
					movePreview = null;
				}}>Not now</Button
			>
			<PendingButton pending={busy === 'move'} onclick={moveIssues}>Move them</PendingButton>
		</div>
	{/if}
</Modal>

<Modal bind:open={removing} title="Remove {pack.name}?">
	{#if !removal}
		<p class="text-muted-foreground text-sm" role="status">Checking…</p>
	{:else if removal.blocked_by.issues.length || removal.blocked_by.schedules.length}
		<p class="text-sm">
			These still use the pack's workflows. Move them to another workflow first:
		</p>
		<ul class="mt-2 list-disc pl-5 text-sm">
			{#each removal.blocked_by.issues as i (i.id)}<li>{i.ref}</li>{/each}
			{#each removal.blocked_by.schedules as s (s.id)}<li>schedule “{s.name}”</li>{/each}
		</ul>
	{:else}
		<p class="text-sm">This deletes the pack's workflows and context.</p>
		{#if removal.additions.length}
			<p class="mt-2 text-sm font-medium">
				This project's own items on its states are deleted too:
			</p>
			<ul class="mt-1 list-disc pl-5 text-sm">
				{#each removal.additions as a (a.id)}<li>{a.kind} {a.name} ({a.scope_label})</li>{/each}
			</ul>
		{/if}
		{#if removal.unbound_inputs.length}
			<p class="mt-2 text-sm font-medium">These inputs become unbound:</p>
			<ul class="mt-1 list-disc pl-5 text-sm">
				{#each removal.unbound_inputs as u (u.pack_id + u.input)}<li>
						{u.pack_name}: {u.input}
					</li>{/each}
			</ul>
		{/if}
		<div class="mt-4 flex justify-end gap-2">
			<Button variant="outline" onclick={() => (removing = false)}>Cancel</Button>
			<PendingButton variant="destructive" pending={busy === 'remove'} onclick={remove}
				>Remove pack</PendingButton
			>
		</div>
	{/if}
</Modal>
