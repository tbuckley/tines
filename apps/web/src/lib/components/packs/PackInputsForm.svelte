<script lang="ts">
	import type { PackInputView } from '@tines/shared';
	import { Input } from '$lib/components/ui/input/index.js';
	import type { InputDraft } from '$lib/packs-client';

	let {
		views,
		drafts = $bindable(),
		workflowOptions,
		idPrefix = 'pack-input'
	}: {
		views: PackInputView[];
		drafts: Record<string, InputDraft>;
		/** `value` is `pack:<wf>[/<state>]` or `<workflow id>[|<state id>]`. */
		workflowOptions: { value: string; label: string }[];
		idPrefix?: string;
	} = $props();
</script>

{#if views.length === 0}
	<p class="text-muted-foreground text-sm">This pack takes no inputs.</p>
{:else}
	<div class="space-y-4">
		{#each views as view (view.name)}
			{@const id = `${idPrefix}-${view.name}`}
			<div>
				<label for={id} class="flex flex-wrap items-baseline gap-2 text-sm font-medium">
					<code>{view.name}</code>
					<span class="text-muted-foreground text-xs font-normal">{view.decl.type}</span>
					{#if view.missing}
						<span class="text-xs font-normal text-amber-700 dark:text-amber-300">needs a value</span
						>
					{/if}
				</label>
				{#if view.decl.description}
					<p class="text-muted-foreground text-xs">{view.decl.description}</p>
				{/if}
				<div class="mt-1.5">
					{#if view.decl.type === 'text'}
						<Input {id} bind:value={drafts[view.name].text} />
					{:else if view.decl.type === 'repo'}
						<div class="flex flex-wrap gap-2">
							<Input
								{id}
								class="min-w-0 flex-1"
								placeholder="https://github.com/owner/repo"
								bind:value={drafts[view.name].repo_url}
							/>
							<Input
								class="w-36"
								aria-label="{view.name} branch"
								placeholder="branch"
								bind:value={drafts[view.name].repo_branch}
							/>
						</div>
					{:else if view.decl.type === 'workflow'}
						<select
							{id}
							class="border-input dark:bg-input/30 h-9 w-full rounded-md border bg-transparent px-3 text-sm"
							bind:value={drafts[view.name].workflow}
						>
							<option value="">Not set</option>
							{#each workflowOptions as option (option.value)}
								<option value={option.value}>{option.label}</option>
							{/each}
						</select>
					{:else}
						<Input
							{id}
							type="password"
							autocomplete="off"
							placeholder={view.my_secret_set
								? 'Your value is set — type to replace it'
								: 'Your own value'}
							bind:value={drafts[view.name].secret}
						/>
						<p class="text-muted-foreground mt-1 text-xs">
							Only you can read this. Everyone who runs this project's issues supplies their own.
						</p>
					{/if}
				</div>
			</div>
		{/each}
	</div>
{/if}
