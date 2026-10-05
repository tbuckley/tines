<script lang="ts">
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import {
		PACK_INPUT_NAME_PATTERN,
		type ContextItem,
		type PackInputDecl,
		type PackInputType,
		type PackInputView,
		type PackWorkflowView
	} from '@tines/shared';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';

	/**
	 * The inputs an authored pack declares: what a project installing it fills
	 * in. Each change saves the whole declaration list.
	 */
	let {
		inputs,
		items,
		workflows,
		pending,
		onsave
	}: {
		inputs: PackInputView[];
		items: ContextItem[];
		workflows: PackWorkflowView[];
		pending: boolean;
		onsave: (inputs: Record<string, PackInputDecl>) => Promise<boolean>;
	} = $props();

	const TYPES: { type: PackInputType; label: string; hint: string }[] = [
		{
			type: 'text',
			label: 'Text',
			hint: 'A word, sentence or paragraph used in prompts and skills.'
		},
		{
			type: 'secret',
			label: 'Secret',
			hint: 'A token or password. Each person supplies their own; bind an env variable to it.'
		},
		{ type: 'repo', label: 'Repository', hint: 'A git repository the agent checks out.' },
		{
			type: 'workflow',
			label: 'Workflow',
			hint: 'Where agents file follow-up issues; renders as the command that files into it.'
		}
	];

	interface Draft {
		/** The input being edited, or null for a new one. */
		original: string | null;
		name: string;
		type: PackInputType;
		description: string;
		text_default: string;
		required: boolean;
		default_branch: string;
		workflow_default: string;
	}

	let draft = $state<Draft | null>(null);
	let error = $state<string | null>(null);

	function usedBy(name: string): ContextItem[] {
		return items.filter((i) => i.pack?.input_refs?.includes(name));
	}

	function startNew() {
		error = null;
		draft = {
			original: null,
			name: '',
			type: 'text',
			description: '',
			text_default: '',
			required: true,
			default_branch: '',
			workflow_default: ''
		};
	}

	function startEdit(view: PackInputView) {
		error = null;
		const d = view.decl;
		draft = {
			original: view.name,
			name: view.name,
			type: d.type,
			description: d.description,
			text_default: d.type === 'text' ? (d.default ?? '') : '',
			required: d.type === 'text' ? d.required !== false : true,
			default_branch: d.type === 'repo' ? (d.default_branch ?? '') : '',
			workflow_default: d.type === 'workflow' ? (d.default ?? '') : ''
		};
	}

	function declOf(d: Draft): PackInputDecl {
		const description = d.description.trim();
		switch (d.type) {
			case 'text':
				return {
					type: 'text',
					description,
					...(d.text_default ? { default: d.text_default } : {}),
					...(d.required ? {} : { required: false })
				};
			case 'secret':
				return { type: 'secret', description };
			case 'repo':
				return {
					type: 'repo',
					description,
					...(d.default_branch.trim() ? { default_branch: d.default_branch.trim() } : {})
				};
			case 'workflow':
				return {
					type: 'workflow',
					description,
					...(d.workflow_default ? { default: d.workflow_default } : {})
				};
		}
	}

	function current(): Record<string, PackInputDecl> {
		return Object.fromEntries(inputs.map((v) => [v.name, v.decl]));
	}

	async function save() {
		if (!draft) return;
		const name = draft.name.trim();
		if (!PACK_INPUT_NAME_PATTERN.test(name)) {
			error =
				'Names start with a lowercase letter and use only lowercase letters, digits and underscores (like repo_url).';
			return;
		}
		if (draft.original === null && inputs.some((v) => v.name === name)) {
			error = `There is already an input named ${name}.`;
			return;
		}
		if (!draft.description.trim()) {
			error = 'Describe the input: the person installing the pack reads this to fill it in.';
			return;
		}
		const next = current();
		next[name] = declOf(draft);
		if (await onsave(next)) draft = null;
	}

	async function remove(view: PackInputView) {
		if (!confirm(`Remove the input ${view.name}? Projects' values for it are deleted.`)) return;
		const next = current();
		delete next[view.name];
		await onsave(next);
	}

	const typeLabel = (t: PackInputType) => TYPES.find((x) => x.type === t)?.label ?? t;
	const selectClass =
		'border-input dark:bg-input/30 mt-1 h-9 w-full rounded-md border bg-transparent px-3 text-sm';
</script>

<div>
	{#if inputs.length === 0 && !draft}
		<p class="text-muted-foreground text-sm">
			No inputs yet. Add one for anything that differs between projects — a repository, a team name,
			an API token — then use it in this pack's prompts, skills and env variables.
		</p>
	{:else}
		<ul class="divide-y rounded-md border">
			{#each inputs as view (view.name)}
				{@const users = usedBy(view.name)}
				<li class="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
					<div class="min-w-0">
						<div class="flex flex-wrap items-baseline gap-2 text-sm">
							<code class="font-medium">{view.name}</code>
							<span class="text-muted-foreground text-xs">{typeLabel(view.decl.type)}</span>
							{#if view.decl.type === 'text' && view.decl.required === false}
								<span class="text-muted-foreground text-xs">optional</span>
							{/if}
						</div>
						<p class="text-muted-foreground text-xs">{view.decl.description}</p>
						<p class="text-muted-foreground text-xs">
							{users.length
								? `Used by ${users.map((u) => u.name).join(', ')}`
								: 'Not used by any item yet'}
						</p>
					</div>
					<div class="flex gap-2">
						<Button size="sm" variant="outline" onclick={() => startEdit(view)}>Edit</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={users.length > 0 || pending}
							title={users.length
								? `Used by ${users.map((u) => u.name).join(', ')}: remove it from them first`
								: undefined}
							onclick={() => remove(view)}>Remove</Button
						>
					</div>
				</li>
			{/each}
		</ul>
	{/if}

	{#if draft}
		<form
			class="bg-muted/40 mt-3 space-y-3 rounded-md border p-3"
			aria-label={draft.original ? `Edit input ${draft.original}` : 'New input'}
			onsubmit={(e) => {
				e.preventDefault();
				save();
			}}
		>
			<div class="grid gap-3 sm:grid-cols-2">
				<div>
					<label for="input-name" class="text-sm font-medium">Name</label>
					<Input
						id="input-name"
						class="mt-1 font-mono"
						placeholder="repo_url"
						bind:value={draft.name}
						disabled={draft.original !== null}
					/>
					<p class="text-muted-foreground mt-1 text-xs">
						{draft.original !== null
							? 'Items refer to an input by name, so it cannot be renamed.'
							: 'Lowercase, digits and underscores. Used as {{ inputs.name }}.'}
					</p>
				</div>
				<div>
					<label for="input-type" class="text-sm font-medium">Type</label>
					<select
						id="input-type"
						class={selectClass}
						bind:value={draft.type}
						disabled={draft.original !== null && usedBy(draft.original).length > 0}
					>
						{#each TYPES as t (t.type)}<option value={t.type}>{t.label}</option>{/each}
					</select>
					<p class="text-muted-foreground mt-1 text-xs">
						{TYPES.find((t) => t.type === draft?.type)?.hint}
					</p>
				</div>
			</div>
			<div>
				<label for="input-description" class="text-sm font-medium">Description</label>
				<Input
					id="input-description"
					class="mt-1"
					placeholder="What to fill in, as the person installing the pack sees it"
					bind:value={draft.description}
				/>
			</div>
			{#if draft.type === 'text'}
				<div class="grid gap-3 sm:grid-cols-2">
					<div>
						<label for="input-default" class="text-sm font-medium">Default (optional)</label>
						<Input id="input-default" class="mt-1" bind:value={draft.text_default} />
					</div>
					<label class="flex items-center gap-2 self-end pb-2 text-sm">
						<input type="checkbox" bind:checked={draft.required} />
						Required — issues wait until it has a value
					</label>
				</div>
			{:else if draft.type === 'repo'}
				<div>
					<label for="input-branch" class="text-sm font-medium">Default branch (optional)</label>
					<Input
						id="input-branch"
						class="mt-1"
						placeholder="main"
						bind:value={draft.default_branch}
					/>
				</div>
			{:else if draft.type === 'workflow'}
				<div>
					<label for="input-workflow" class="text-sm font-medium">Default (optional)</label>
					<select id="input-workflow" class={selectClass} bind:value={draft.workflow_default}>
						<option value="">None — the project picks one</option>
						{#each workflows as wf (wf.id)}
							{#each wf.states as s, i (s.id)}
								<option value={i === 0 ? wf.key : `${wf.key}/${s.key}`}
									>{wf.name}{i === 0 ? '' : `, starting in ${s.name}`}</option
								>
							{/each}
						{/each}
					</select>
				</div>
			{/if}
			{#if error}<p class="text-sm text-red-600" role="alert">{error}</p>{/if}
			<div class="flex justify-end gap-2">
				<Button variant="outline" onclick={() => (draft = null)}>Cancel</Button>
				<PendingButton type="submit" {pending}
					>{draft.original ? 'Save input' : 'Add input'}</PendingButton
				>
			</div>
		</form>
	{:else}
		<Button class="mt-3" size="sm" variant="outline" onclick={startNew}>
			<IconPlus size={16} /> Add input
		</Button>
	{/if}
</div>
