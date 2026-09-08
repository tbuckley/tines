<script lang="ts">
	import {
		siteEntry,
		type Artifact,
		type ArtifactDetail,
		type ArtifactSiteLink,
		type ArtifactVersion,
		type ArtifactVersionFile
	} from '@tines/shared';
	import IconChevronLeft from '@tabler/icons-svelte/icons/chevron-left';
	import IconChevronRight from '@tabler/icons-svelte/icons/chevron-right';
	import IconDownload from '@tabler/icons-svelte/icons/download';
	import IconExternalLink from '@tabler/icons-svelte/icons/external-link';
	import IconCode from '@tabler/icons-svelte/icons/code';
	import IconFile from '@tabler/icons-svelte/icons/file';
	import IconFolder from '@tabler/icons-svelte/icons/folder';
	import { api } from '$lib/api';
	import Markdown from '$lib/components/Markdown.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import { Select } from '$lib/components/ui/select/index.js';
	import { actorLabel, relativeTime } from '$lib/format';

	let {
		issueId,
		artifacts,
		open = $bindable(false),
		selectedName = $bindable<string | null>(null),
		initialVersion = null,
		initialPath = null
	}: {
		issueId: string;
		artifacts: Artifact[];
		open?: boolean;
		/** The artifact the viewer shows; the header dropdown switches it. */
		selectedName?: string | null;
		initialVersion?: number | null;
		initialPath?: string | null;
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
	/** Site view: the minted link, and the two ways out of the rendered page. */
	let siteLink = $state<ArtifactSiteLink | null>(null);
	let siteError = $state<string | null>(null);
	let showSource = $state(false);
	let showFiles = $state(false);
	/** Simulated device width for the frame; `null` fills the dialog. */
	let deviceWidth = $state<number | null>(null);

	let loadToken = 0;
	let wasOpen = false;
	let openingName: string | null = null;
	$effect(() => {
		if (!open) {
			loadToken += 1;
			wasOpen = false;
			openingName = null;
			return;
		}
		if (!wasOpen) openingName = selectedName;
		wasOpen = true;
	});
	$effect(() => {
		if (!open || !selectedName) return;
		const name = selectedName;
		const token = ++loadToken;
		detail = null;
		loadError = null;
		versionPick = selectedName === openingName ? initialVersion : null;
		pathPick = selectedName === openingName ? initialPath : null;
		showSource = false;
		showFiles = false;
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
		return detail.versions.find((v) => v.version === versionPick) ?? null;
	});

	// Stepping through a folder is just moving `pathPick` along the version's
	// file list, which the API already returns in `path asc` order: every
	// downstream derived (preview, textKey, the text fetch, fileBody) reacts to
	// it exactly as it does to a click on the index.
	const folderFiles = $derived(detail?.artifact_type === 'folder' ? (version?.files ?? []) : []);
	/** Index of `pathPick` in `folderFiles`; -1 on the index view or a stale pick. */
	const fileIndex = $derived(
		pathPick === null ? -1 : folderFiles.findIndex((f) => f.path === pathPick)
	);
	const hasPrev = $derived(fileIndex > 0);
	const hasNext = $derived(fileIndex >= 0 && fileIndex < folderFiles.length - 1);

	function step(delta: -1 | 1) {
		if (fileIndex < 0) return;
		const next = folderFiles[fileIndex + delta];
		if (!next) return; // the ends stop rather than wrap
		pathPick = next.path;
	}

	const contentUrl = (opts: { path?: string; inline?: boolean; download?: boolean } = {}) => {
		const params = new URLSearchParams();
		if (versionPick !== null) params.set('version', String(versionPick));
		if (opts.path !== undefined) params.set('path', opts.path);
		if (opts.inline) params.set('inline', '1');
		const q = params.toString();
		return `/api/v1/issues/${issueId}/artifacts/${encodeURIComponent(selectedName ?? '')}/content${q ? `?${q}` : ''}`;
	};

	/**
	 * The entry document when this version is a site (HTML file/text, or a
	 * folder with a root index.html) — the thing `/s/<token>/` will serve.
	 */
	const entry = $derived(
		detail && version
			? siteEntry(detail.artifact_type, version.content_type, version.files ?? [])
			: null
	);
	/** The site renders unless the reader asked for the source or a folder file. */
	const isSite = $derived(entry !== null && !showSource && !showFiles && pathPick === null);

	type ViewKind = 'site' | 'image' | 'pdf' | 'markdown' | 'text' | 'download';
	function viewKind(contentType: string | null): ViewKind {
		const ct = contentType ?? '';
		if (ct.startsWith('image/')) return 'image';
		if (ct === 'application/pdf') return 'pdf';
		if (ct === 'text/markdown') return 'markdown';
		if (ct.startsWith('text/') || ct === 'application/json') return 'text';
		return 'download';
	}

	/** The one thing being rendered: the version payload, or a folder entry. */
	const preview = $derived.by(
		(): { kind: ViewKind; path?: string; contentType: string | null } | null => {
			if (!detail || !version) return null;
			if (isSite) return { kind: 'site', contentType: version.content_type };
			if (detail.artifact_type === 'folder') {
				if (pathPick === null) return null;
				const file = (version.files ?? []).find((f) => f.path === pathPick);
				return file
					? { kind: viewKind(file.content_type), path: file.path, contentType: file.content_type }
					: null;
			}
			if (detail.artifact_type === 'file' || detail.artifact_type === 'text') {
				return { kind: viewKind(version.content_type), contentType: version.content_type };
			}
			return null;
		}
	);

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

	// One mint per artifact+version entering the site view: the link is a
	// capability with an hour's life, so it is re-minted whenever the version
	// pick changes or the viewer is reopened.
	let siteToken = 0;
	$effect(() => {
		if (!isSite || !selectedName || !version) {
			return;
		}
		const name = selectedName;
		const pinned = version.version;
		const token = ++siteToken;
		siteLink = null;
		siteError = null;
		api
			.createArtifactSiteLink(issueId, name, { version: pinned })
			.then((link) => {
				if (token === siteToken) siteLink = link;
			})
			.catch(() => {
				if (token === siteToken) siteError = 'Couldn’t open this preview — close and retry.';
			});
	});

	/**
	 * `allow-same-origin` is only safe on the dedicated sandbox host, where the
	 * page's origin is not ours; on the app origin the server's CSP `sandbox`
	 * already forces an opaque origin, and granting it here would undo that.
	 * Neither mode grants top navigation, so the page cannot move the app.
	 */
	const frameSandbox = $derived(
		siteLink?.mode === 'sandbox-origin'
			? 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups'
			: 'allow-scripts allow-forms allow-modals allow-popups'
	);

	const WIDTHS: { label: string; width: number | null }[] = [
		{ label: 'Phone', width: 390 },
		{ label: 'Tablet', width: 768 },
		{ label: 'Full', width: null }
	];

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

	// Mirrors Modal's Escape handler: a window listener, no focus trap. Guarded
	// so the header's native <select>s (artifact, version), any text field, and
	// browser/OS shortcuts keep their own arrow-key behaviour.
	function onkeydown(e: KeyboardEvent) {
		if (!open || fileIndex < 0 || e.defaultPrevented) return;
		if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
		const target = e.target as HTMLElement | null;
		if (target?.closest('input, select, textarea, [contenteditable]')) return;
		if (e.key === 'ArrowLeft') step(-1);
		else if (e.key === 'ArrowRight') step(1);
		else return;
		e.preventDefault();
	}
</script>

<svelte:window {onkeydown} />

<Modal bind:open title="Artifact viewer" size="xl">
	<!-- header: artifact switcher, version picker, download -->
	<div class="mb-3 flex flex-wrap items-center gap-2">
		<Select
			bind:value={() => selectedName ?? '', (v) => (selectedName = v || null)}
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
				{#each [...detail.versions]
					.reverse()
					.filter((v) => v.version !== detail!.current_version.version) as v (v.version)}
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

	{#if detail && version && pathPick !== null && fileIndex < 0}
		<div class="rounded-md border border-dashed p-4 text-sm">
			<p>This file is unavailable in version {version.version}.</p>
			<div class="mt-2 flex flex-wrap gap-3">
				<button
					type="button"
					class="text-muted-foreground text-xs underline"
					onclick={() => (pathPick = null)}
				>
					Open the folder index
				</button>
				{#if versionPick !== null}
					<button
						type="button"
						class="text-muted-foreground text-xs underline"
						onclick={() => {
							versionPick = null;
							pathPick = null;
						}}
					>
						Open the current version
					</button>
				{/if}
			</div>
		</div>
	{:else if detail && version}
		<!-- metadata line -->
		<p class="text-muted-foreground mb-3 text-xs">
			{detail.artifact_type}{version.content_type
				? ` · ${version.content_type}`
				: ''}{version.file_count !== null
				? ` · ${version.file_count} file${version.file_count === 1 ? '' : 's'}`
				: ''}{version.size_bytes !== null ? ` · ${version.size_bytes.toLocaleString()} bytes` : ''}
			· {actorLabel(version.actor)} ·
			<span title={new Date(version.created_at).toLocaleString()}
				>{relativeTime(version.created_at)}</span
			>
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
					{#if version.title}<span class="text-muted-foreground block truncate text-xs"
							>{version.url}</span
						>{/if}
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
		{:else if detail.artifact_type === 'folder' && isSite}
			{@render fileBody()}
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
							<span class="text-muted-foreground block truncate px-1 pt-1 text-xs">{file.path}</span
							>
						</button>
					{/each}
				</div>
			{:else if pathPick === null}
				<ul class="divide-y rounded-md border">
					{#each files as file (file.path)}
						<li class="flex items-center gap-2 px-3 py-2 text-sm">
							<IconFile size={14} class="text-muted-foreground shrink-0" />
							{#if viewKind(file.content_type) !== 'download'}
								<button
									type="button"
									class="min-w-0 truncate text-left hover:underline"
									onclick={() => (pathPick = file.path)}
								>
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
				<!-- Wraps rather than overflows on a phone (Tines/30 pattern): the path
				     truncates and the trailing cluster drops to its own line. -->
				<div class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
					<button
						type="button"
						class="text-muted-foreground hover:text-foreground shrink-0 hover:underline"
						onclick={() => (pathPick = null)}
					>
						← all files
					</button>
					<span class="min-w-0 grow basis-40 truncate font-mono" title={pathPick}>{pathPick}</span>
					<div class="ml-auto flex shrink-0 items-center gap-1">
						<!-- `aria-disabled` rather than `disabled` at the ends: stepping onto the
						     last file must not drop the focus the next press needs. -->
						<button
							type="button"
							class="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 items-center gap-0.5 rounded-md px-1.5 aria-disabled:pointer-events-none aria-disabled:opacity-40"
							aria-disabled={!hasPrev}
							aria-label="Previous file"
							onclick={() => step(-1)}
						>
							<IconChevronLeft size={14} /> Prev
						</button>
						{#if fileIndex >= 0}
							<span class="text-muted-foreground tabular-nums" aria-live="polite">
								{fileIndex + 1} of {folderFiles.length}
							</span>
						{/if}
						<button
							type="button"
							class="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 items-center gap-0.5 rounded-md px-1.5 aria-disabled:pointer-events-none aria-disabled:opacity-40"
							aria-disabled={!hasNext}
							aria-label="Next file"
							onclick={() => step(1)}
						>
							Next <IconChevronRight size={14} />
						</button>
						<a
							href={contentUrl({ path: pathPick })}
							class="text-muted-foreground hover:text-foreground ml-1 inline-flex h-8 items-center gap-1 px-1"
						>
							<IconDownload size={13} /> Download
						</a>
					</div>
				</div>
				{@render fileBody()}
			{/if}
		{:else}
			{@render fileBody()}
		{/if}
		{#if entry !== null && (showSource || showFiles)}
			<button
				type="button"
				class="text-muted-foreground hover:text-foreground mt-2 inline-flex items-center gap-1 text-xs"
				onclick={() => {
					showSource = false;
					showFiles = false;
					pathPick = null;
				}}
			>
				← Back to the rendered page
			</button>
		{/if}
	{:else if loadError}
		<p
			class="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm"
		>
			{loadError}
		</p>
	{:else if detail && !version}
		<div class="rounded-md border border-dashed p-4 text-sm">
			<p>This version is unavailable.</p>
			<button
				type="button"
				class="text-muted-foreground mt-2 text-xs underline"
				onclick={() => {
					versionPick = null;
					pathPick = null;
				}}
			>
				Open the current version
			</button>
		</div>
	{:else}
		<p class="text-muted-foreground text-sm">Loading…</p>
	{/if}
</Modal>

{#snippet fileBody()}
	{#if preview}
		{#if preview.kind === 'site'}
			<div class="space-y-2">
				<div class="flex flex-wrap items-center gap-2">
					<div
						role="radiogroup"
						aria-label="Preview width"
						class="hidden items-center gap-1 rounded-md border p-0.5 sm:flex"
					>
						{#each WIDTHS as choice (choice.label)}
							<button
								type="button"
								role="radio"
								aria-checked={deviceWidth === choice.width}
								class="rounded px-2 py-1 text-xs {deviceWidth === choice.width
									? 'bg-muted font-medium'
									: 'text-muted-foreground hover:text-foreground'}"
								onclick={() => (deviceWidth = choice.width)}
							>
								{choice.label}
							</button>
						{/each}
					</div>
					{#if siteLink}
						<a
							href={siteLink.url}
							target="_blank"
							rel="noopener noreferrer"
							class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
						>
							<IconExternalLink size={14} /> Open full page
						</a>
					{/if}
					{#if detail?.artifact_type === 'folder'}
						<button
							type="button"
							class="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-xs"
							onclick={() => (showFiles = true)}
						>
							<IconFolder size={14} /> Files
						</button>
					{:else}
						<button
							type="button"
							class="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-xs"
							onclick={() => (showSource = true)}
						>
							<IconCode size={14} /> Source
						</button>
					{/if}
				</div>
				{#if siteError}
					<p
						class="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm"
					>
						{siteError}
					</p>
				{:else if siteLink}
					<div
						class="mx-auto w-full"
						style={deviceWidth ? `max-width:${deviceWidth}px` : undefined}
					>
						<iframe
							src={siteLink.url}
							title={`${selectedName} preview`}
							sandbox={frameSandbox}
							referrerpolicy="no-referrer"
							loading="lazy"
							class="h-[70dvh] w-full rounded-md border bg-white"
						></iframe>
					</div>
					{#if siteLink.mode === 'same-origin'}
						<p class="text-muted-foreground text-xs">
							Sandboxed on the app origin — storage APIs (localStorage, cookies) are unavailable
							here.
						</p>
					{/if}
				{:else}
					<p class="text-muted-foreground text-xs">Preparing preview…</p>
				{/if}
			</div>
		{:else if preview.kind === 'image'}
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
