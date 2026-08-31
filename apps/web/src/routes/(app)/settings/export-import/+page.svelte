<script lang="ts">
	import { ApiError, type ImportLibraryResponse, type LibraryDocument } from '@tines/shared';
	import IconDownload from '@tabler/icons-svelte/icons/download';
	import IconUpload from '@tabler/icons-svelte/icons/upload';
	import { invalidateAll } from '$app/navigation';
	import { api } from '$lib/api';
	import { Button } from '$lib/components/ui/button/index.js';

	let includeJournalsOnExport = $state(true);
	let exporting = $state(false);
	let exportError = $state<string | null>(null);

	let fileName = $state<string | null>(null);
	let document_ = $state<LibraryDocument | null>(null);
	let preview = $state<ImportLibraryResponse | null>(null);
	let result = $state<ImportLibraryResponse | null>(null);
	let busy = $state(false);
	let importError = $state<string | null>(null);

	// Options are re-planned on change, so the preview always shows what the
	// confirm would actually do.
	let overwrite = $state(false);
	let createProjects = $state(true);
	let includeJournalsOnImport = $state(true);

	const message = (err: unknown, fallback: string) =>
		err instanceof ApiError ? err.message : fallback;

	async function download() {
		if (exporting) return;
		exporting = true;
		exportError = null;
		try {
			const doc = await api.exportLibrary({ journals: includeJournalsOnExport });
			const day = new Date(doc.exported_at).toISOString().slice(0, 10);
			const url = URL.createObjectURL(
				new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
			);
			const a = window.document.createElement('a');
			a.href = url;
			a.download = `tines-library-${day}.json`;
			a.click();
			URL.revokeObjectURL(url);
		} catch (err) {
			exportError = message(err, 'Failed to build the export.');
		} finally {
			exporting = false;
		}
	}

	async function chooseFile(e: Event) {
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		reset();
		if (!file) return;
		fileName = file.name;
		try {
			document_ = JSON.parse(await file.text()) as LibraryDocument;
		} catch {
			importError = 'That file is not valid JSON.';
			return;
		}
		await plan();
	}

	function reset() {
		fileName = null;
		document_ = null;
		preview = null;
		result = null;
		importError = null;
	}

	const options = () => ({
		on_collision: overwrite ? ('overwrite' as const) : ('skip' as const),
		create_projects: createProjects,
		include_journals: includeJournalsOnImport
	});

	async function plan() {
		if (!document_) return;
		busy = true;
		importError = null;
		result = null;
		try {
			preview = await api.importLibrary({ document: document_, dry_run: true, ...options() });
		} catch (err) {
			preview = null;
			importError = message(err, 'That file could not be read as a library export.');
		} finally {
			busy = false;
		}
	}

	async function confirm() {
		if (!document_ || busy) return;
		busy = true;
		importError = null;
		try {
			result = await api.importLibrary({ document: document_, ...options() });
			preview = null;
			await invalidateAll();
		} catch (err) {
			importError = message(err, 'The import failed.');
		} finally {
			busy = false;
		}
	}

	/**
	 * "3 created, 2 skipped" — the counts worth reading, in a fixed order.
	 * Each action carries both wordings; the past tense is irregular often
	 * enough that deriving it from the other is wrong.
	 */
	function summary(report: ImportLibraryResponse): string {
		const labels: [keyof typeof report.counts, string, string][] = [
			['create', 'to create', 'created'],
			['overwrite', 'to overwrite', 'overwritten'],
			['skip', 'to skip', 'skipped'],
			['refuse', 'to refuse', 'refused'],
			['error', 'failing', 'failed']
		];
		const parts = labels
			.filter(([k]) => report.counts[k] > 0)
			.map(([k, pending, past]) => `${report.counts[k]} ${report.applied ? past : pending}`);
		return parts.length === 0 ? 'nothing to do' : parts.join(', ');
	}

	const report = $derived(result ?? preview);
</script>

<svelte:head><title>Export / import · Tines</title></svelte:head>

<h1 class="mb-2 text-2xl font-semibold tracking-tight">Export / import</h1>
<p class="text-muted-foreground mb-6 max-w-2xl text-sm">
	Move your library — workflows and context items — between deployments, or keep a backup of it.
	Issues, comments, runs, and artifacts are not included, and neither are API keys or any other
	credential.
</p>

<section class="mb-8 rounded-lg border p-4">
	<h2 class="mb-1 text-lg font-medium">Export</h2>
	<p class="text-muted-foreground mb-3 max-w-2xl text-sm">
		Downloads one JSON file with every workflow you own and every context item that is not tied to
		a single issue. Prompts, skills, and journals are included <span class="font-medium">in full</span
		> — treat the file as sensitive if you have pasted anything private into a prompt.
	</p>
	<label class="mb-3 flex items-center gap-2 text-sm">
		<input type="checkbox" bind:checked={includeJournalsOnExport} class="size-4" />
		Include journals (each stage's accumulated notes)
	</label>
	{#if exportError}
		<p class="text-destructive mb-3 text-sm">{exportError}</p>
	{/if}
	<Button onclick={download} disabled={exporting}>
		<IconDownload size={16} />
		{exporting ? 'Preparing…' : 'Download library'}
	</Button>
</section>

<section class="rounded-lg border p-4">
	<h2 class="mb-1 text-lg font-medium">Import</h2>
	<p class="text-muted-foreground mb-3 max-w-2xl text-sm">
		Upload a file exported from Tines. Nothing is written until you confirm the preview, and
		anything that collides with what you already have is skipped by default.
	</p>

	<label class="mb-3 flex items-center gap-2 text-sm">
		<input
			type="file"
			accept="application/json,.json"
			onchange={chooseFile}
			class="text-sm file:mr-3 file:rounded-md file:border file:bg-transparent file:px-3 file:py-1.5 file:text-sm"
			aria-label="Library file"
		/>
	</label>

	{#if document_}
		<div class="mb-3 flex flex-wrap gap-4 text-sm">
			<label class="flex items-center gap-2">
				<input type="checkbox" bind:checked={overwrite} onchange={plan} class="size-4" />
				Overwrite existing context items
			</label>
			<label class="flex items-center gap-2">
				<input type="checkbox" bind:checked={createProjects} onchange={plan} class="size-4" />
				Create missing projects
			</label>
			<label class="flex items-center gap-2">
				<input
					type="checkbox"
					bind:checked={includeJournalsOnImport}
					onchange={plan}
					class="size-4"
				/>
				Include journals
			</label>
		</div>
	{/if}

	{#if importError}
		<p class="text-destructive mb-3 text-sm" data-testid="import-error">{importError}</p>
	{/if}

	{#if report}
		<p class="mb-2 text-sm" data-testid="import-summary">
			{#if result}Imported{fileName ? ` ${fileName}` : ''}: {summary(report)}.
			{:else}Preview of {fileName}: {summary(report)}. Nothing has been written yet.{/if}
		</p>
		<div class="max-h-96 overflow-y-auto rounded-lg border">
			<table class="w-full text-sm">
				<thead class="bg-muted/50 sticky top-0">
					<tr class="text-left">
						<th class="px-3 py-2 font-medium">Item</th>
						<th class="px-3 py-2 font-medium">Action</th>
						<th class="px-3 py-2 font-medium">Why</th>
					</tr>
				</thead>
				<tbody class="divide-y">
					{#each report.entries as entry, i (entry.section + entry.ref + i)}
						<tr data-testid="import-row">
							<td class="px-3 py-1.5">{entry.ref}</td>
							<td
								class="px-3 py-1.5 font-medium {entry.action === 'error' ||
								entry.action === 'refuse'
									? 'text-destructive'
									: entry.action === 'skip'
										? 'text-muted-foreground'
										: ''}">{entry.action}</td
							>
							<td class="text-muted-foreground px-3 py-1.5">{entry.reason ?? ''}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	{#if preview && !result}
		<div class="mt-3 flex gap-2">
			<Button onclick={confirm} disabled={busy}>
				<IconUpload size={16} />
				{busy ? 'Importing…' : 'Import'}
			</Button>
			<Button variant="outline" onclick={reset} disabled={busy}>Cancel</Button>
		</div>
	{/if}
</section>
