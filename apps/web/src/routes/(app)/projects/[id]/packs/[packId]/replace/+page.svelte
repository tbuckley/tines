<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import IconChevronLeft from '@tabler/icons-svelte/icons/chevron-left';
	import type { PackReceipt, PackReview, PackUpload } from '@tines/shared';
	import PackReviewView from '$lib/components/packs/PackReviewView.svelte';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import {
		draftFor,
		packApi,
		uploadFromFiles,
		valueFromDraft,
		type InputDraft
	} from '$lib/packs-client';

	let { data } = $props();
	let upload = $state<PackUpload | null>(null);
	let review = $state<PackReview | null>(null);
	let drafts = $state<Record<string, InputDraft>>({});
	let mapping = $state<Record<string, string>>({});
	let confirmVersion = $state(false);
	let busy = $state(false);
	let message = $state<string | null>(null);
	const base = $derived(`/api/v1/projects/${data.project.id}/packs/${data.pack.id}`);
	const workflowOptions = $derived([
		...(review?.model?.workflows ?? []).map((w) => ({
			value: `pack:${w.key}`,
			label: `${w.name} (this pack)`
		})),
		...data.workflowOptions
	]);

	async function prepare(body: object) {
		busy = true;
		message = null;
		review = null;
		try {
			const r = await packApi<PackReview>(`${base}/replace/prepare`, 'POST', body);
			drafts = Object.fromEntries(r.inputs.map((v) => [v.name, draftFor(v)]));
			mapping = Object.fromEntries(
				(r.state_mapping ?? []).map((m) => [m.state_id, m.suggested ?? ''])
			);
			confirmVersion = false;
			review = r;
		} catch (e) {
			message = e instanceof Error ? e.message : 'Could not read the pack';
		} finally {
			busy = false;
		}
	}
	onMount(() => {
		if (data.fromSource) void prepare({ from_source: true });
	});
	async function pickFiles(event: Event) {
		const files = (event.currentTarget as HTMLInputElement).files;
		if (!files?.length) return;
		upload = await uploadFromFiles(files);
		await prepare(upload);
	}
	const unmapped = $derived(
		(review?.state_mapping ?? []).filter((m) => !mapping[m.state_id]).length
	);
	async function replace() {
		if (!review) return;
		busy = true;
		message = null;
		try {
			const values: Record<string, unknown> = {};
			const my_secrets: Record<string, string> = {};
			for (const view of review.inputs) {
				const d = drafts[view.name];
				if (view.decl.type === 'secret') {
					if (d.secret) my_secrets[view.name] = d.secret;
					continue;
				}
				// Values the project already has stay as they are; only fill new or changed ones.
				const v = valueFromDraft(view, d);
				if (v !== undefined) values[view.name] = v;
			}
			const receipt = await packApi<PackReceipt>(`${base}/replace`, 'POST', {
				...(upload ?? { from_source: true }),
				expected_digest: review.digest,
				confirm_version: confirmVersion,
				state_mapping: mapping,
				values,
				my_secrets
			});
			await goto(`/projects/${data.project.id}/packs/${receipt.pack.id}`);
		} catch (e) {
			message = e instanceof Error ? e.message : 'Replace failed';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Replace {data.pack.name} · Tines</title></svelte:head>

<div class="mx-auto max-w-3xl pb-16">
	<a
		class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
		href={`/projects/${data.project.id}/packs/${data.pack.id}`}
		><IconChevronLeft size={16} />{data.pack.name}</a
	>
	<h1 class="mt-5 text-2xl font-semibold">
		{data.fromSource ? 'Update from source' : 'Replace with a new version'}
	</h1>
	<p class="text-muted-foreground mt-1 text-sm">
		Currently {data.pack.version !== null ? `version ${data.pack.version}` : 'never exported'}.
		Replacing keeps this project's input values, schedules and its own items on the pack's states.
	</p>

	{#if !data.fromSource}
		<section
			class="mt-6 grid gap-4 rounded-lg border p-4 sm:grid-cols-2"
			aria-label="Choose the new version"
		>
			<div>
				<label for="pack-file" class="text-sm font-medium">A .tinespack file</label>
				<input
					id="pack-file"
					class="mt-1 block w-full text-sm"
					type="file"
					accept=".tinespack,.zip"
					onchange={pickFiles}
				/>
			</div>
			<div>
				<label for="pack-folder" class="text-sm font-medium">Or a folder</label>
				<input
					id="pack-folder"
					class="mt-1 block w-full text-sm"
					type="file"
					webkitdirectory
					onchange={pickFiles}
				/>
			</div>
		</section>
	{/if}

	{#if message}<p class="mt-4 text-sm text-red-600" role="alert">{message}</p>{/if}
	{#if busy && !review}<p class="text-muted-foreground mt-4 text-sm" role="status">
			Reading the pack…
		</p>{/if}

	{#if review}
		{#if review.discards_authored_edits}
			<p class="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
				This pack has edits made here since its last export. Replacing discards them.
			</p>
		{/if}
		<div class="mt-4">
			<PackReviewView {review} bind:drafts bind:mapping {workflowOptions} />
		</div>
		{#if review.model}
			<div
				class="bg-background sticky bottom-0 mt-6 flex flex-wrap items-center justify-end gap-4 border-t py-4"
			>
				{#if review.version_warning}
					<label class="flex items-center gap-2 text-sm">
						<input type="checkbox" bind:checked={confirmVersion} />
						{review.version_warning === 'lower_version'
							? `Replace with older version ${review.model.manifest.version}`
							: 'Replace with different content under the same version'}
					</label>
				{/if}
				{#if unmapped}<span class="text-muted-foreground text-sm"
						>Map {unmapped} removed state{unmapped === 1 ? '' : 's'}</span
					>{/if}
				<PendingButton
					pending={busy}
					disabled={unmapped > 0 ||
						(review.version_warning !== null &&
							review.version_warning !== undefined &&
							!confirmVersion)}
					onclick={replace}>Replace</PendingButton
				>
			</div>
		{/if}
	{/if}
</div>
