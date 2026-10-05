<script lang="ts">
	import { goto } from '$app/navigation';
	import IconChevronLeft from '@tabler/icons-svelte/icons/chevron-left';
	import type { PackReceipt, PackReview, PackUpload } from '@tines/shared';
	import PackReviewView from '$lib/components/packs/PackReviewView.svelte';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import {
		browserTimezone,
		draftFor,
		packApi,
		uploadFromFiles,
		valueFromDraft,
		type InputDraft
	} from '$lib/packs-client';

	let { data } = $props();
	let upload = $state<PackUpload | null>(null);
	let sourcePackId = $state('');
	let review = $state<PackReview | null>(null);
	let drafts = $state<Record<string, InputDraft>>({});
	let schedules = $state<Record<string, { checked: boolean; timezone: string }>>({});
	let authored = $state(false);
	let busy = $state(false);
	let message = $state<string | null>(null);

	const base = $derived(`/api/v1/projects/${data.project.id}/packs`);
	/** Workflow inputs may also name this pack's own workflows, which install creates. */
	const workflowOptions = $derived([
		...(review?.model?.workflows ?? []).flatMap((w) => [
			{ value: `pack:${w.key}`, label: `${w.name} (this pack)` },
			...w.states
				.filter((s) => s.key !== w.initial)
				.map((s) => ({
					value: `pack:${w.key}/${s.key}`,
					label: `${w.name} (this pack), starting in ${s.name}`
				}))
		]),
		...data.workflowOptions
	]);

	async function prepare(body: object) {
		busy = true;
		message = null;
		review = null;
		try {
			const r = await packApi<PackReview>(`${base}/install/prepare`, 'POST', body);
			drafts = Object.fromEntries(r.inputs.map((v) => [v.name, draftFor(v)]));
			schedules = Object.fromEntries(
				(r.model?.schedules ?? []).map((s) => [
					s.key,
					{ checked: false, timezone: browserTimezone() }
				])
			);
			review = r;
		} catch (e) {
			message = e instanceof Error ? e.message : 'Could not read the pack';
		} finally {
			busy = false;
		}
	}

	async function pickFiles(event: Event) {
		const files = (event.currentTarget as HTMLInputElement).files;
		if (!files?.length) return;
		sourcePackId = '';
		upload = await uploadFromFiles(files);
		await prepare(upload);
	}

	async function pickSource() {
		upload = null;
		if (sourcePackId) await prepare({ source_pack_id: sourcePackId });
	}

	async function install() {
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
				const v = valueFromDraft(view, d);
				if (v !== undefined) values[view.name] = v;
			}
			const receipt = await packApi<PackReceipt>(`${base}/install`, 'POST', {
				...(upload ?? { source_pack_id: sourcePackId }),
				expected_digest: review.digest,
				authored,
				values,
				my_secrets,
				schedules: Object.entries(schedules)
					.filter(([, s]) => s.checked)
					.map(([key, s]) => ({ key, timezone: s.timezone }))
			});
			await goto(`/projects/${data.project.id}/packs/${receipt.pack.id}`);
		} catch (e) {
			message = e instanceof Error ? e.message : 'Install failed';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Install a pack · {data.project.name} · Tines</title></svelte:head>

<div class="mx-auto max-w-3xl pb-16">
	<a
		class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
		href={`/projects/${data.project.id}/packs`}><IconChevronLeft size={16} />Packs</a
	>
	<h1 class="mt-5 text-2xl font-semibold">Install a pack</h1>

	<section class="mt-6 grid gap-4 rounded-lg border p-4 sm:grid-cols-2" aria-label="Choose a pack">
		<div>
			<label for="pack-file" class="text-sm font-medium">From a file</label>
			<input
				id="pack-file"
				class="mt-1 block w-full text-sm"
				type="file"
				accept=".tinespack,.zip"
				onchange={pickFiles}
			/>
			<label for="pack-folder" class="mt-3 block text-sm font-medium">Or a folder</label>
			<input
				id="pack-folder"
				class="mt-1 block w-full text-sm"
				type="file"
				webkitdirectory
				onchange={pickFiles}
			/>
		</div>
		<div>
			<label for="pack-source" class="text-sm font-medium">From my projects</label>
			<select
				id="pack-source"
				class="border-input dark:bg-input/30 mt-1 h-9 w-full rounded-md border bg-transparent px-3 text-sm"
				bind:value={sourcePackId}
				onchange={pickSource}
				disabled={data.sources.length === 0}
			>
				<option value=""
					>{data.sources.length ? 'Choose a pack…' : 'No packs in your other projects'}</option
				>
				{#each data.sources as s (s.pack_id)}
					<option value={s.pack_id}
						>{s.name} — {s.project_name}{s.version !== null ? ` · v${s.version}` : ''}</option
					>
				{/each}
			</select>
			<p class="text-muted-foreground mt-1 text-xs">
				Copies its current content. An authored pack is exported now, taking a new version if it
				changed.
			</p>
		</div>
	</section>

	{#if message}<p class="mt-4 text-sm text-red-600" role="alert">{message}</p>{/if}
	{#if busy && !review}<p class="text-muted-foreground mt-4 text-sm" role="status">
			Reading the pack…
		</p>{/if}

	{#if review}
		<div class="mt-6">
			<h2 class="text-xl font-semibold">
				{review.model?.manifest.name ?? 'Review'}
				{#if review.model?.manifest.version}<span
						class="text-muted-foreground text-base font-normal"
						>v{review.model.manifest.version}</span
					>{/if}
			</h2>
			{#if review.model?.manifest.description}
				<p class="text-muted-foreground mt-1 text-sm">{review.model.manifest.description}</p>
			{/if}
			{#if review.already_installed}
				<p class="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
					This pack is already installed here as “{review.already_installed.name}”.
					<a
						class="underline"
						href={`/projects/${data.project.id}/packs/${review.already_installed.pack_id}/replace`}
						>Replace it</a
					> instead.
				</p>
			{/if}
		</div>
		<div class="mt-4">
			<PackReviewView {review} bind:drafts bind:schedules {workflowOptions} />
		</div>
		{#if review.model && !review.already_installed}
			<div
				class="bg-background sticky bottom-0 mt-6 flex flex-wrap items-center justify-end gap-4 border-t py-4"
			>
				<label class="flex items-center gap-2 text-sm">
					<input type="checkbox" bind:checked={authored} />
					Install as an editable (authored) pack
				</label>
				<PendingButton pending={busy} onclick={install}>Install</PendingButton>
			</div>
		{/if}
	{/if}
</div>
