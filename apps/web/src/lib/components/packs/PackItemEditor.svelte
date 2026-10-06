<script lang="ts">
	import { onMount } from 'svelte';
	import type { ContextFile, ContextItem, PackDetail } from '@tines/shared';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import InsertInput from '$lib/components/packs/InsertInput.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { packApi, skillBody, skillMarkdown } from '$lib/packs-client';

	/**
	 * Adds a context item to an authored pack, or edits one of its items: a
	 * prompt, a skill, an env variable or a repo. Text fields take
	 * `{{ inputs.<name> }}` placeholders (Insert input); env and repo items can
	 * take their whole value from an input instead.
	 */
	let {
		pack,
		base,
		item = null,
		pending,
		run,
		ondone
	}: {
		pack: PackDetail;
		/** The pack's API path, `/api/v1/projects/<id>/packs/<id>`. */
		base: string;
		/** The item to edit; null adds a new one. */
		item?: ContextItem | null;
		pending: boolean;
		/** The page's request runner: shows errors, reloads, returns null on failure. */
		run: <T>(key: string, fn: () => Promise<T>) => Promise<T | null>;
		ondone: () => void;
	} = $props();

	const reaches = [
		['project', 'Every issue in this project'],
		['pack', "Issues in any of this pack's workflows"],
		['workflow', 'One workflow'],
		['state', 'One state']
	] as const;
	const KINDS = [
		['prompt', 'Prompt'],
		['skill', 'Skill'],
		['env', 'Env variable'],
		['repo', 'Repository']
	] as const;
	type Kind = (typeof KINDS)[number][0];

	// svelte-ignore state_referenced_locally
	const editing = item;
	let reach = $state<string>('project');
	let target = $state('');
	let kind = $state<Kind>((editing?.kind as Kind) ?? 'prompt');
	let name = $state(editing?.name ?? '');
	let description = $state(editing?.description ?? '');
	let body = $state(editing?.kind === 'prompt' ? (editing.body ?? '') : '');
	/** env/repo: '' = a fixed value, else the input it is bound to. */
	let input = $state(editing?.pack?.input ?? '');
	let value = $state(editing?.kind === 'env' && !editing.pack?.input ? (editing.value ?? '') : '');
	let repoUrl = $state(
		editing?.kind === 'repo' && !editing.pack?.input ? (editing.repo_url ?? '') : ''
	);
	let repoBranch = $state(
		editing?.kind === 'repo' && !editing.pack?.input ? (editing.repo_branch ?? '') : ''
	);
	let skillFiles = $state<ContextFile[]>([]);
	let loadingSkill = $state(editing?.kind === 'skill');
	let error = $state<string | null>(null);

	let bodyField = $state<HTMLTextAreaElement | null>(null);
	let valueField = $state<HTMLInputElement | null>(null);

	onMount(async () => {
		if (editing?.kind !== 'skill') return;
		try {
			const full = await packApi<ContextItem>(`/api/v1/context/${editing.id}`);
			skillFiles = full.files ?? [];
			body = skillBody(skillFiles.find((f) => f.path === 'SKILL.md')?.content ?? '');
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not load the skill';
		} finally {
			loadingSkill = false;
		}
	});

	const bindable = $derived(
		pack.inputs.filter((i) =>
			kind === 'env'
				? i.decl.type === 'text' || i.decl.type === 'secret'
				: kind === 'repo' && i.decl.type === 'repo'
		)
	);
	const otherFiles = $derived(skillFiles.filter((f) => f.path !== 'SKILL.md'));
	const selectClass =
		'border-input dark:bg-input/30 h-9 w-full rounded-md border bg-transparent px-3 text-sm';

	function skillFilesFor(): ContextFile[] {
		return [
			{ path: 'SKILL.md', content: skillMarkdown(name.trim(), description.trim(), body) },
			...otherFiles
		];
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		error = null;
		if (!name.trim()) {
			error = 'Give it a name.';
			return;
		}
		if (kind === 'skill' && !description.trim()) {
			error = 'Describe the skill: agents read the description to decide when to use it.';
			return;
		}
		const ok = editing ? await saveEdit() : await create();
		if (ok) ondone();
	}

	function create() {
		return run('item', () =>
			packApi(`${base}/items`, 'POST', {
				reach,
				...(reach === 'workflow' ? { workflow_id: target } : {}),
				...(reach === 'state' ? { state_id: target } : {}),
				kind,
				name: name.trim(),
				...(description.trim() ? { description: description.trim() } : {}),
				...(kind === 'prompt' ? { body } : {}),
				...(kind === 'skill' ? { files: skillFilesFor() } : {}),
				...(kind === 'env' ? (input ? { input } : { value }) : {}),
				...(kind === 'repo'
					? input
						? { input }
						: { repo_url: repoUrl.trim(), repo_branch: repoBranch.trim() || null }
					: {})
			})
		);
	}

	function saveEdit() {
		const it = editing!;
		return run('item', async () => {
			let version = it.version;
			const patch: Record<string, unknown> = {};
			if (name.trim() !== it.name) patch.name = name.trim();
			if (description.trim() !== (it.description ?? '')) patch.description = description.trim();
			if (kind === 'prompt') patch.body = body;
			if (kind === 'skill') patch.files = skillFilesFor();
			if (Object.keys(patch).length) {
				const updated = await packApi<ContextItem>(`/api/v1/context/${it.id}`, 'PATCH', {
					...patch,
					expected_version: version
				});
				version = updated.version;
			}
			if (kind === 'env' || kind === 'repo')
				await packApi(`${base}/items/${it.id}`, 'PATCH', {
					input: input || null,
					...(kind === 'env' && !input ? { value } : {}),
					...(kind === 'repo' && !input
						? { repo_url: repoUrl.trim(), repo_branch: repoBranch.trim() || null }
						: {}),
					expected_version: version
				});
			return true;
		});
	}
</script>

<form
	class="space-y-3"
	aria-label={editing ? `Edit ${editing.kind} ${editing.name}` : 'Add context'}
	onsubmit={submit}
>
	{#if !editing}
		<div class="grid gap-2 sm:grid-cols-3">
			<div>
				<label for="item-reach" class="text-xs font-medium">Applies to</label>
				<select id="item-reach" class="{selectClass} mt-1" bind:value={reach}>
					{#each reaches as [r, label] (r)}<option value={r}>{label}</option>{/each}
				</select>
			</div>
			{#if reach === 'workflow' || reach === 'state'}
				<div>
					<label for="item-target" class="text-xs font-medium"
						>{reach === 'workflow' ? 'Workflow' : 'State'}</label
					>
					<select id="item-target" class="{selectClass} mt-1" bind:value={target}>
						<option value="">Choose…</option>
						{#each pack.workflows as wf (wf.id)}
							{#if reach === 'workflow'}
								<option value={wf.id}>{wf.name}</option>
							{:else}
								{#each wf.states as s (s.id)}<option value={s.id}>{wf.name} / {s.name}</option
									>{/each}
							{/if}
						{/each}
					</select>
				</div>
			{/if}
			<div>
				<label for="item-kind" class="text-xs font-medium">Kind</label>
				<select id="item-kind" class="{selectClass} mt-1" bind:value={kind}>
					{#each KINDS as [k, label] (k)}<option value={k}>{label}</option>{/each}
				</select>
			</div>
		</div>
	{/if}

	<div class="grid gap-2 sm:grid-cols-2">
		<div>
			<label for="item-name" class="text-xs font-medium">Name</label>
			<Input
				id="item-name"
				class="mt-1 {kind === 'env' ? 'font-mono' : ''}"
				placeholder={kind === 'env' ? 'VARIABLE_NAME' : kind === 'skill' ? 'skill-name' : 'name'}
				bind:value={name}
			/>
		</div>
		{#if kind === 'prompt' || kind === 'skill'}
			<div>
				<label for="item-description" class="text-xs font-medium"
					>Description{kind === 'prompt' ? ' (optional)' : ''}</label
				>
				<Input
					id="item-description"
					class="mt-1"
					placeholder={kind === 'skill' ? 'When agents should use this skill' : ''}
					bind:value={description}
				/>
			</div>
		{/if}
	</div>

	{#if kind === 'prompt' || kind === 'skill'}
		<div>
			<div class="flex flex-wrap items-end justify-between gap-2">
				<label for="item-body" class="text-xs font-medium"
					>{kind === 'prompt' ? 'Prompt' : 'Instructions (SKILL.md)'}</label
				>
				<InsertInput bind:value={body} field={bodyField} inputs={pack.inputs} />
			</div>
			<Textarea
				id="item-body"
				class="mt-1 font-mono text-xs"
				rows={kind === 'skill' ? 12 : 8}
				placeholder="Markdown. Insert an input where its value should go."
				disabled={loadingSkill}
				bind:ref={bodyField}
				bind:value={body}
			/>
			{#if kind === 'skill' && otherFiles.length}
				<p class="text-muted-foreground mt-1 text-xs">
					Also in this skill: {otherFiles.map((f) => f.path).join(', ')} (kept as they are).
				</p>
			{/if}
			{#if pack.inputs.length === 0}
				<p class="text-muted-foreground mt-1 text-xs">
					Add inputs above to plug project-specific values into this text.
				</p>
			{/if}
		</div>
	{:else}
		<div class="grid gap-2 sm:grid-cols-2">
			<div>
				<label for="item-source" class="text-xs font-medium">Value</label>
				<select id="item-source" class="{selectClass} mt-1" bind:value={input}>
					<option value="">{kind === 'env' ? 'Fixed text' : 'A fixed repository'}</option>
					{#each bindable as i (i.name)}
						<option value={i.name}>From input {i.name} ({i.decl.type})</option>
					{/each}
				</select>
			</div>
			{#if !input}
				{#if kind === 'env'}
					<div>
						<div class="flex flex-wrap items-end justify-between gap-2">
							<label for="item-value" class="text-xs font-medium">Text</label>
							<InsertInput
								bind:value
								field={valueField}
								inputs={pack.inputs.filter((i) => i.decl.type === 'text')}
							/>
						</div>
						<Input id="item-value" class="mt-1" bind:ref={valueField} bind:value />
					</div>
				{:else}
					<div class="flex gap-2 sm:mt-5">
						<Input
							aria-label="Repository URL"
							class="min-w-0 flex-1"
							placeholder="https://github.com/owner/repo"
							bind:value={repoUrl}
						/>
						<Input aria-label="Branch" class="w-28" placeholder="branch" bind:value={repoBranch} />
					</div>
				{/if}
			{/if}
		</div>
		{#if bindable.length === 0}
			<p class="text-muted-foreground text-xs">
				{kind === 'env'
					? 'Add a text or secret input above to take this value from each project.'
					: 'Add a repository input above to let each project choose its repository.'}
			</p>
		{/if}
	{/if}

	{#if error}<p class="text-sm text-red-600" role="alert">{error}</p>{/if}
	<div class="flex justify-end gap-2">
		{#if editing}<Button variant="outline" onclick={ondone}>Cancel</Button>{/if}
		<PendingButton type="submit" {pending}>{editing ? 'Save' : 'Add'}</PendingButton>
	</div>
</form>
