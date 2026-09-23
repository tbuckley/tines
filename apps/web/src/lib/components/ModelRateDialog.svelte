<script lang="ts">
	import type {
		CreateUserModelRateRequest,
		SupervisorRatesResponse,
		UserModelRate
	} from '@tines/shared';
	import { ApiError } from '@tines/shared';
	import { api } from '$lib/api';
	import Modal from '$lib/components/Modal.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';

	let {
		open = $bindable(false),
		model = '',
		modelReadonly = false,
		rates,
		initial = null,
		onclose,
		onsaved
	}: {
		open?: boolean;
		model?: string;
		modelReadonly?: boolean;
		rates: SupervisorRatesResponse;
		initial?: UserModelRate | null;
		onclose?: () => void;
		onsaved?: () => void | Promise<void>;
	} = $props();
	let input = $state('');
	let read = $state('');
	let write = $state('');
	let output = $state('');
	let copiedFrom = $state('');
	let reprice = $state(true);
	let saving = $state(false);
	let error = $state<string | null>(null);
	let initialized = $state(false);

	$effect(() => {
		if (!open) {
			initialized = false;
			return;
		}
		if (initialized) return;
		initialized = true;
		input = initial?.input_rate ?? '';
		read = initial?.cache_read_rate ?? '';
		write = initial?.cache_write_rate ?? '';
		output = initial?.output_rate ?? '';
		copiedFrom = '';
		error = null;
	});

	function copyFrom(value: string) {
		copiedFrom = value;
		const source = rates.builtin.find((entry) => entry.model === value);
		if (!source) return;
		input = source.rates.input_tokens ?? '';
		read = source.rates.cache_read_tokens ?? '';
		write = source.rates.cache_write_tokens ?? '';
		output = source.rates.output_tokens ?? '';
	}

	async function save() {
		if (saving) return;
		saving = true;
		error = null;
		try {
			const body: CreateUserModelRateRequest = {
				model: model.trim(),
				input_rate: input.trim(),
				cache_read_rate: read.trim(),
				cache_write_rate: write.trim() || null,
				output_rate: output.trim(),
				...(copiedFrom ? { copied_from: copiedFrom } : {}),
				reprice
			};
			const result = await api.createSupervisorRate(body);
			// Page by cursor: runs this rate still cannot price stay unpriced, so
			// `remaining` may never reach zero.
			let cursor = result.next_cursor;
			while (cursor) cursor = (await api.repriceSupervisorRate(model.trim(), cursor)).next_cursor;
			open = false;
			await onsaved?.();
			onclose?.();
		} catch (e) {
			error =
				e instanceof ApiError
					? e.message
					: e instanceof Error
						? e.message
						: 'Could not save this rate';
		} finally {
			saving = false;
		}
	}
</script>

<Modal
	bind:open
	title={initial ? `Edit rate for ${model}` : `Add rate for ${model || 'a model'}`}
	{onclose}
	dismissible={!saving}
>
	<form
		class="space-y-4"
		onsubmit={(event) => {
			event.preventDefault();
			void save();
		}}
	>
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="rate-model">Model</label><Input
				id="rate-model"
				value={model}
				readonly={modelReadonly || initial !== null}
				oninput={(e) => (model = e.currentTarget.value)}
			/>
		</div>
		<div class="grid grid-cols-2 gap-3">
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="rate-input">Input / 1M</label><Input
					id="rate-input"
					value={input}
					oninput={(e) => (input = e.currentTarget.value)}
				/>
			</div>
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="rate-read">Cache read / 1M</label><Input
					id="rate-read"
					value={read}
					oninput={(e) => (read = e.currentTarget.value)}
				/>
			</div>
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="rate-write">Cache write / 1M</label><Input
					id="rate-write"
					value={write}
					placeholder="none"
					oninput={(e) => (write = e.currentTarget.value)}
				/>
			</div>
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="rate-output">Output / 1M</label><Input
					id="rate-output"
					value={output}
					oninput={(e) => (output = e.currentTarget.value)}
				/>
			</div>
		</div>
		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="rate-copy">Copy from</label><Select
				id="rate-copy"
				value={copiedFrom}
				onchange={(e) => copyFrom(e.currentTarget.value)}
				><option value="">No prefill</option>{#each rates.builtin as entry (entry.model)}<option
						value={entry.model}>{entry.model}</option
					>{/each}</Select
			>
		</div>
		<label class="flex items-center gap-2 text-sm"
			><input type="checkbox" bind:checked={reprice} />Also price {rates.unpriced_models.find(
				(entry) => entry.model === model
			)?.runs ?? 0} existing runs for this model</label
		>
		{#if error}<p class="text-sm text-red-600">{error}</p>{/if}
		<div class="flex justify-end gap-2">
			<Button type="button" variant="ghost" disabled={saving} onclick={() => (open = false)}
				>Cancel</Button
			><Button type="submit" disabled={saving || !model.trim()}
				>{saving ? 'Saving…' : 'Save rate'}</Button
			>
		</div>
	</form>
</Modal>
