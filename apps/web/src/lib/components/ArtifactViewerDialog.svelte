<script lang="ts">
	import type { Artifact, ArtifactDetail, ArtifactVersion, ArtifactVersionFile } from '@tines/shared';
	import IconDownload from '@tabler/icons-svelte/icons/download';
	import IconExternalLink from '@tabler/icons-svelte/icons/external-link';
	import IconFile from '@tabler/icons-svelte/icons/file';
	import { api } from '$lib/api';
	import Markdown from '$lib/components/Markdown.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import { Select } from '$lib/components/ui/select/index.js';
	import { actorLabel, relativeTime } from '$lib/format';

	let {
		issueId,
		artifacts,
		open = $bindable(false),
		selectedName = $bindable<string | null>(null)
	}: {
		issueId: string;
		artifacts: Artifact[];
		open?: boolean;
		/** The artifact the viewer shows; the header dropdown switches it. */
		selectedName?: string | null;
	} = $props();

	// The viewer is a reader over the detail read (versions incl. folder file
	// lists); everything below derives from `detail` + the two selections.
	let detail = $state<ArtifactDetail | null>(null);
	let loadError = $state<string | null>(null);
	/** null = the current version. */
	let versionPick = $state<number | null>(null);
	/** Folder-only: the file being previewed. */
	let pathPick = $state<string | null>(null);
	/** Fetched text contents, keyed by name@version[/path]. */
	let textCache = $state<Record<string, string>>({});

	let loadToken = 0;
	$effect(() => {
		if (!open || !selectedName) return;
		const name = selectedName;
		const token = ++loadToken;
		detail = null;
		loadError = null;
		versionPick = null;
		pathPick = null;
		api
			.getArtifact(issueId, name)
			.then((full) => {
				if (token === loadToken && open) detail = full;
			})
			.catch(() => {
				if (token === loadToken) loadError = 'Couldn’t load this artifact — close and retry.';
			});
	});

	const version = $derived.by((): ArtifactVersion | null => {
		if (!detail) return null;
		if (versionPick === null) return detail.current_version;
		return detail.versions.find((v) => v.version === versionPick) ?? detail.current_version;
	});

	const contentUrl = (opts: { path?: string; inline?: boolean; download?: boolean } = {}) => {
		const params = new URLSearchParams();
		if (versionPick !== null) params.set('version', String(versionPick));
		if (opts.path !== undefined) params.set('path', opts.path);
		if (opts.inline) params.set('inline', '1');
		const q = params.toString();
		return `/api/v1/issues/${issueId}/artifacts/${encodeURIComponent(selectedName ?? '')}/content${q ? `?${q}` : ''}`;
	};

	type ViewKind = 'image' | 'pdf' | 'markdown' | 'text' | 'download';
	function viewKind(contentType: string | null): ViewKind {
		const ct = contentType ?? '';
		if (ct.startsWith('image/')) return 'image';
		if (ct === 'application/pdf') return 'pdf';
		if (ct === 'text/markdown') return 'markdown';
		if (ct.startsWith('text/') || ct === 'application/json') return 'text';
		return 'download';
	}

	/** The one thing being rendered: the version payload, or a folder entry. */
	const preview = $derived.by((): { kind: ViewKind; path?: string; contentType: string | null } | null => {
		if (!detail || !version) return null;
		if (detail.artifact_type === 'folder') {
			if (pathPick === null) return null;
			const file = (version.files ?? []).find((f) => f.path === pathPick);
			return file ? { kind: viewKind(file.content_type), path: file.path, contentType: file.content_type } : null;
		}
		if (detail.artifact_type === 'file' || detail.artifact_type === 'text') {
			return { kind: viewKind(version.content_type), contentType: version.content_type };
		}
		return null;
	});

	const textKey = $derived(
		preview && (preview.kind === 'markdown' || preview.kind === 'text')
			? `${selectedName}@${version?.version}${preview.path ? `/${preview.path}` : ''}`
			: null
	);
	$effect(() => {
		const key = textKey;
		if (!key || textCache[key] !== undefined || !selectedName) return;
		const opts = { version: version?.version, path: preview?.path };
		api
			.getArtifactContent(issueId, selectedName, opts)
			.then((content) => {
				textCache = { ...textCache, [key]: new TextDecoder().decode(content.bytes) };
			})
			.catch(() => {
				textCache = { ...textCache, [key]: '(failed to load content)' };
			});
	});

	const allImages = (files: ArtifactVersionFile[]) =>
		files.length > 0 && files.every((f) => f.content_type.startsWith('image/'));

	function versionLabel(v: ArtifactVersion): string {
		const parts = [`v${v.version}`];
		if (v.reaffirmed_from !== null) parts.push(`reaffirmed v${v.reaffirmed_from}`);
		parts.push(new Date(v.created_at).toLocaleDateString());
		return parts.join(' · ');
	}

	const prUrl = (v: ArtifactVersion) => `${v.pr_repo_url}/pull/${v.pr_number}`;
	const prRef = (v: ArtifactVersion) =>
		`${(v.pr_repo_url ?? '').replace(/^https:\/\/github\.com\//, '')}#${v.pr_number}`;
</script>

<Modal bind:open title="Artifact viewer" size="xl">
	<!-- header: artifact switcher, version picker, download -->
	<div class="mb-3 flex flex-wrap items-center gap-2">
		<Select
			bind:value={
				() => selectedName ?? '',
				(v) => (selectedName = v || null)
			}
			class="h-8 w-48 text-sm"
			aria-label="Artifact"
		>
			{#each artifacts as artifact (artifact.id)}
				<option value={artifact.name}>{artifact.name} ({artifact.artifact_type})</option>
			{/each}
		</Select>
		{#if detail}
			<Select
				bind:value={
					() => (versionPick === null ? 'current' : String(versionPick)),
					(v) => {
						versionPick = v === 'current' ? null : Number.parseInt(v, 10);
						pathPick = null;
					}
				}
				class="h-8 w-56 text-sm"
				aria-label="Version"
			>
				<option value="current">{versionLabel(detail.current_version)} (current)</option>
				{#each [...detail.versions].reverse().filter((v) => v.version !== detail!.current_version.version) as v (v.version)}
					<option value={String(v.version)}>{versionLabel(v)}</option>
				{/each}
			</Select>
			{#if detail.artifact_type === 'file' || detail.artifact_type === 'text'}
				<a
					href={contentUrl()}
					class="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-xs"
				>
					<IconDownload size={14} /> Download
				</a>
			{/if}
		{/if}
	</div>

	{#if detail && version}
		<!-- metadata line -->
		<p class="text-muted-foreground mb-3 text-xs">
			{detail.artifact_type}{version.content_type ? ` · ${version.content_type}` : ''}{version.file_count !== null
				? ` · ${version.file_count} file${version.file_count === 1 ? '' : 's'}`
				: ''}{version.size_bytes !== null ? ` · ${version.size_bytes.toLocaleString()} bytes` : ''}
			· {actorLabel(version.actor)} ·
			<span title={new Date(version.created_at).toLocaleString()}>{relativeTime(version.created_at)}</span>
			{#if versionPick === null}
				· {detail.fresh ? 'fresh' : 'attached before the current state'}
			{/if}
			{#if detail.description}
				<span class="block italic">{detail.description}</span>
			{/if}
		</p>

		{#if detail.artifact_type === 'link'}
			<a
				href={version.url}
				target="_blank"
				rel="noreferrer noopener"
				class="hover:bg-muted/50 flex items-center gap-2 rounded-md border p-4 text-sm"
			>
				<IconExternalLink size={16} class="shrink-0" />
				<span class="min-w-0">
					<span class="block font-medium">{version.title ?? version.url}</span>
					{#if version.title}<span class="text-muted-foreground block truncate text-xs">{version.url}</span>{/if}
				</span>
			</a>
		{:else if detail.artifact_type === 'pr'}
			<a
				href={prUrl(version)}
				target="_blank"
				rel="noreferrer noopener"
				class="hover:bg-muted/50 flex items-center gap-2 rounded-md border p-4 text-sm"
			>
				<IconExternalLink size={16} class="shrink-0" />
				<span class="font-medium">{prRef(version)}</span>
				<span class="text-muted-foreground truncate text-xs">{prUrl(version)}</span>
			</a>
		{:else if detail.artifact_type === 'folder'}
			{@const files = version.files ?? []}
			{#if pathPick === null && allImages(files)}
				<!-- an all-image set is a gallery; anything mixed is a tree -->
				<div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
					{#each files as file (file.path)}
						<button
							type="button"
							class="group rounded-md border p-1 text-left"
							onclick={() => (pathPick = file.path)}
							title={`View ${file.path}`}
						>
							<img
								src={contentUrl({ path: file.path, inline: true })}
								alt={file.path}
								loading="lazy"
								class="h-36 w-full rounded object-cover"
							/>
							<span class="text-muted-foreground block truncate px-1 pt-1 text-xs">{file.path}</span>
						</button>
					{/each}
				</div>
			{:else if pathPick === null}
				<ul class="divide-y rounded-md border">
					{#each files as file (file.path)}
						<li class="flex items-center gap-2 px-3 py-2 text-sm">
							<IconFile size={14} class="text-muted-foreground shrink-0" />
							{#if viewKind(file.content_type) !== 'download'}
								<button type="button" class="min-w-0 truncate text-left hover:underline" onclick={() => (pathPick = file.path)}>
									{file.path}
								</button>
							{:else}
								<span class="min-w-0 truncate">{file.path}</span>
							{/if}
							<span class="text-muted-foreground ml-auto shrink-0 text-xs">
								{file.content_type} · {file.size_bytes.toLocaleString()} bytes
							</span>
							<a
								href={contentUrl({ path: file.path })}
								class="text-muted-foreground hover:text-foreground shrink-0"
								aria-label={`Download ${file.path}`}
							>
								<IconDownload size={14} />
							</a>
						</li>
					{/each}
				</ul>
			{:else}
				<div class="mb-2 flex items-center gap-2 text-xs">
					<button type="button" class="text-muted-foreground hover:text-foreground hover:underline" onclick={() => (pathPick = null)}>
						← all files
					</button>
					<span class="font-mono">{pathPick}</span>
					<a href={contentUrl({ path: pathPick })} class="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1">
						<IconDownload size={13} /> Download
					</a>
				</div>
				{@render fileBody()}
			{/if}
		{:else}
			{@render fileBody()}
		{/if}
	{:else if loadError}
		<p class="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
			{loadError}
		</p>
	{:else}
		<p class="text-muted-foreground text-sm">Loading…</p>
	{/if}
</Modal>

{#snippet fileBody()}
	{#if preview}
		{#if preview.kind === 'image'}
			<img
				src={contentUrl({ path: preview.path, inline: true })}
				alt={preview.path ?? selectedName}
				class="max-h-[70dvh] w-auto rounded-md border"
			/>
		{:else if preview.kind === 'pdf'}
			<!-- the sandboxed inline URL is what makes PDF preview possible -->
			<iframe
				src={contentUrl({ path: preview.path, inline: true })}
				title={preview.path ?? selectedName}
				class="h-[70dvh] w-full rounded-md border"
			></iframe>
		{:else if preview.kind === 'markdown'}
			<div class="rounded-md border p-4">
				{#if textKey && textCache[textKey] !== undefined}
					<Markdown source={textCache[textKey]} class="text-sm" />
				{:else}
					<p class="text-muted-foreground text-xs">Loading…</p>
				{/if}
			</div>
		{:else if preview.kind === 'text'}
			{#if textKey && textCache[textKey] !== undefined}
				<pre class="overflow-x-auto rounded-md border p-4 text-xs">{textCache[textKey]}</pre>
			{:else}
				<p class="text-muted-foreground text-xs">Loading…</p>
			{/if}
		{:else}
			<a
				href={contentUrl({ path: preview.path })}
				class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-md border p-4 text-sm"
			>
				<IconDownload size={14} />
				Download ({preview.contentType ?? 'file'} — no inline preview)
			</a>
		{/if}
	{/if}
{/snippet}
