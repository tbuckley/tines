<script lang="ts">
	import { tick } from 'svelte';
	import type { PackInputView } from '@tines/shared';
	import { insertAtCursor, placeholderFor } from '$lib/packs-client';

	/**
	 * Inserts `{{ inputs.<name> }}` at the cursor of `field` (or at the end).
	 * Secret inputs never render as text, so they are not offered.
	 */
	let {
		value = $bindable(),
		field,
		inputs,
		label = 'Insert input'
	}: {
		value: string;
		field: HTMLInputElement | HTMLTextAreaElement | null | undefined;
		inputs: PackInputView[];
		label?: string;
	} = $props();

	const offered = $derived(inputs.filter((i) => i.decl.type !== 'secret'));
	let choice = $state('');

	async function insert(name: string) {
		if (!name) return;
		const out = insertAtCursor(value, placeholderFor(name), field);
		value = out.value;
		choice = '';
		await tick();
		field?.focus();
		field?.setSelectionRange(out.cursor, out.cursor);
	}
</script>

{#if offered.length}
	<select
		aria-label={label}
		class="border-input dark:bg-input/30 h-8 rounded-md border bg-transparent px-2 text-xs"
		bind:value={choice}
		onchange={() => insert(choice)}
	>
		<option value="">{label}…</option>
		{#each offered as i (i.name)}
			<option value={i.name}>{i.name} ({i.decl.type})</option>
		{/each}
	</select>
{/if}
