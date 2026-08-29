<script lang="ts">
	import type { AllowedTransition, Artifact, ArtifactType, ArtifactVersion } from '@tines/shared';
	import { ApiError, ARTIFACT_NAME_PATTERN, parsePrSpec } from '@tines/shared';
	import IconCheck from '@tabler/icons-svelte/icons/check';
	import IconDownload from '@tabler/icons-svelte/icons/download';
	import IconExternalLink from '@tabler/icons-svelte/icons/external-link';
	import IconFile from '@tabler/icons-svelte/icons/file';
	import IconFileText from '@tabler/icons-svelte/icons/file-text';
	import IconGitPullRequest from '@tabler/icons-svelte/icons/git-pull-request';
	import IconHistory from '@tabler/icons-svelte/icons/history';
	import IconLink from '@tabler/icons-svelte/icons/link';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import IconRefresh from '@tabler/icons-svelte/icons/refresh';
	import IconTrash from '@tabler/icons-svelte/icons/trash';
	import { slide } from 'svelte/transition';
	import { api } from '$lib/api';
	import Markdown from '$lib/components/Markdown.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Select } from '$lib/components/ui/select/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { actorLabel, prefersReducedMotion, relativeTime } from '$lib/format';

	let {
		issueId,
		artifacts,
		allowedTransitions,
		onchanged,
		onerror
	}: {
		issueId: string;
		artifacts: Artifact[];
		/** For the requirement-relevant stale badge (allowed moves' requires). */
		allowedTransitions: AllowedTransition[];
		onchanged: () => void | Promise<void>;
		onerror: (e: unknown) => void;
	} = $props();

	const dur = () => (prefersReducedMotion() ? 0 : 180);

	const typeIcons = {
		file: IconFile,
		text: IconFileText,
		link: IconLink,
		pr: IconGitPullRequest
	} as const;

	/** Slots some transition out of the current state requires — only those
	 * get nagged with a stale badge (incidental attachments do not). */
	const requiredSlots = $derived(
		new Set(allowedTransitions.flatMap((t) => (t.requires ?? []).map((r) => r.artifact)))
	);

	const contentUrl = (name: string, opts: { version?: number; inline?: boolean } = {}) => {
		const params = new URLSearchParams();
		if (opts.version !== undefined) params.set('version', String(opts.version));
		if (opts.inline) params.set('inline', '1');
		const q = params.toString();
		return `/api/v1/issues/${issueId}/artifacts/${encodeURIComponent(name)}/content${q ? `?${q}` : ''}`;
	};

	const prUrl = (v: Pick<ArtifactVersion, 'pr_repo_url' | 'pr_number'>) =>
		`${v.pr_repo_url}/pull/${v.pr_number}`;
	const prRef = (v: Pick<ArtifactVersion, 'pr_repo_url' | 'pr_number'>) =>
		`${(v.pr_repo_url ?? '').replace(/^https:\/\/github\.com\//, '')}#${v.pr_number}`;

	// --- previews ---------------------------------------------------------------

	let openPreview = $state<string | null>(null);
	/** Fetched text contents per artifact id (Markdown/plain-text previews). */
	let textPreviews = $state<Record<string, string>>({});

	function previewKind(a: Artifact): 'image' | 'markdown' | 'text' | 'download' {
		const ct = a.current_version.content_type ?? '';
		if (ct.startsWith('image/')) return 'image';
		if (ct === 'text/markdown') return 'markdown';
		if (ct.startsWith('text/')) return 'text';
		return 'download';
	}

	async function togglePreview(a: Artifact) {
		if (openPreview === a.id) {
			openPreview = null;
			return;
		}
		openPreview = a.id;
		const kind = previewKind(a);
		if ((kind === 'markdown' || kind === 'text') && textPreviews[a.id] === undefined) {
			try {
				const content = await api.getArtifactContent(issueId, a.name);
				textPreviews = { ...textPreviews, [a.id]: new TextDecoder().decode(content.bytes) };
			} catch (e) {
				onerror(e);
			}
		}
	}

	// --- history ----------------------------------------------------------------

	let openHistory = $state<string | null>(null);
	let histories = $state<Record<string, ArtifactVersion[]>>({});

	async function toggleHistory(a: Artifact) {
		if (openHistory === a.id) {
			openHistory = null;
			return;
		}
		openHistory = a.id;
		try {
			const detail = await api.getArtifact(issueId, a.name);
			histories = { ...histories, [a.id]: [...detail.versions].reverse() };
		} catch (e) {
			onerror(e);
		}
	}

	// --- mutations ----------------------------------------------------------------

	let busy = $state(false);

	async function reaffirm(a: Artifact) {
		if (busy) return;
		busy = true;
		try {
			await api.reaffirmArtifact(issueId, a.name);
			histories = {};
			await onchanged();
		} catch (e) {
			onerror(e);
		} finally {
			busy = false;
		}
	}

	async function remove(a: Artifact) {
		if (busy || !confirm(`Delete artifact "${a.name}" and all ${a.version_count} version${a.version_count === 1 ? '' : 's'}?`)) {
			return;
		}
		busy = true;
		try {
			await api.deleteArtifact(issueId, a.name);
			await onchanged();
		} catch (e) {
			onerror(e);
		} finally {
			busy = false;
		}
	}

	// --- attach dialog ------------------------------------------------------------

	let attachOpen = $state(false);
	/** Locked when attaching a new version to an existing artifact. */
	let attachTo = $state<Artifact | null>(null);
	let attachName = $state('');
	let attachType = $state<ArtifactType>('file');
	let attachDescription = $state('');
	let attachFile = $state<File | null>(null);
	let attachText = $state('');
	let attachUrl = $state('');
	let attachTitle = $state('');
	let attachPr = $state('');
	let attachError = $state<string | null>(null);
	let attaching = $state(false);
	let dragOver = $state(false);

	function openAttach(existing: Artifact | null) {
		attachTo = existing;
		attachName = existing?.name ?? '';
		attachType = existing?.artifact_type ?? 'file';
		attachDescription = existing?.description ?? '';
		attachFile = null;
		attachText = '';
		attachUrl = existing?.artifact_type === 'link' ? (existing.current_version.url ?? '') : '';
		attachTitle = '';
		attachPr = '';
		attachError = null;
		attachOpen = true;
	}

	const attachReady = $derived.by(() => {
		if (!ARTIFACT_NAME_PATTERN.test(attachName)) return false;
		switch (attachType) {
			case 'file':
				return attachFile !== null;
			case 'text':
				return attachText.trim().length > 0;
			case 'link':
				return attachUrl.trim().length > 0;
			case 'pr':
				return parsePrSpec(attachPr) !== null;
		}
	});

	async function submitAttach(e: SubmitEvent) {
		e.preventDefault();
		if (attaching || !attachReady) return;
		attaching = true;
		attachError = null;
		try {
			const description = attachDescription.trim() || undefined;
			if (attachType === 'file') {
				const file = attachFile!;
				await api.uploadArtifactFile(issueId, attachName, await file.arrayBuffer(), {
					filename: file.name,
					contentType: file.type || 'application/octet-stream'
				});
				if (description !== undefined) {
					await api.putArtifact(issueId, attachName, { description });
				}
			} else if (attachType === 'text') {
				await api.putArtifact(issueId, attachName, { type: 'text', content: attachText, description });
			} else if (attachType === 'link') {
				await api.putArtifact(issueId, attachName, {
					type: 'link',
					url: attachUrl.trim(),
					title: attachTitle.trim() || undefined,
					description
				});
			} else {
				const parsed = parsePrSpec(attachPr)!;
				await api.putArtifact(issueId, attachName, {
					type: 'pr',
					pr_repo_url: parsed.repo_url,
					pr_number: parsed.number,
					description
				});
			}
			attachOpen = false;
			histories = {};
			textPreviews = {};
			await onchanged();
		} catch (err) {
			attachError = err instanceof ApiError ? err.message : 'Something went wrong — try again.';
		} finally {
			attaching = false;
		}
	}
</script>

<section class="rounded-lg border">
	<header class="flex items-center justify-between border-b px-4 py-2.5">
		<h2 class="text-sm font-semibold">
			Artifacts
			{#if artifacts.length > 0}
				<span class="text-muted-foreground font-normal">({artifacts.length})</span>
			{/if}
		</h2>
		<Button size="sm" variant="ghost" onclick={() => openAttach(null)}>
			<IconPlus size={14} /> Attach artifact
		</Button>
	</header>
	<div class="p-4">
		{#if artifacts.length === 0}
			<p class="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
				No artifacts attached — attach the work products this issue produces (documents, screenshots,
				links, PRs). Workflow transitions can require them.
			</p>
		{:else}
			<ul class="divide-y rounded-lg border">
				{#each artifacts as artifact (artifact.id)}
					{@const TypeIcon = typeIcons[artifact.artifact_type]}
					{@const stale = !artifact.fresh && requiredSlots.has(artifact.name)}
					{@const cv = artifact.current_version}
					<li class="px-3 py-2.5" transition:slide={{ duration: dur() }}>
						<div class="flex items-center gap-3">
							<span class="text-muted-foreground shrink-0" title={artifact.artifact_type}>
								<TypeIcon size={16} stroke={1.75} />
							</span>
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-2 text-sm">
									<span class="font-medium">{artifact.name}</span>
									{#if stale}
										<span
											class="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400"
											title="The current version predates this state — a transition requiring this artifact is blocked until a new version is attached or it is reaffirmed"
										>
											stale
										</span>
									{/if}
									{#if artifact.artifact_type === 'link'}
										<a
											href={cv.url}
											target="_blank"
											rel="noreferrer noopener"
											class="text-muted-foreground hover:text-foreground inline-flex min-w-0 items-center gap-1 truncate text-xs"
										>
											<IconExternalLink size={12} />
											{cv.title ?? cv.url}
										</a>
									{:else if artifact.artifact_type === 'pr'}
										<a
											href={prUrl(cv)}
											target="_blank"
											rel="noreferrer noopener"
											class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
										>
											<IconExternalLink size={12} />
											{prRef(cv)}
										</a>
									{:else}
										<button
											type="button"
											class="text-muted-foreground hover:text-foreground truncate text-xs hover:underline"
											onclick={() => togglePreview(artifact)}
										>
											{cv.filename}
										</button>
									{/if}
								</div>
								{#if artifact.description}
									<p class="text-muted-foreground truncate text-xs">{artifact.description}</p>
								{/if}
								<p class="text-muted-foreground text-xs">
									v{cv.version}
									{#if cv.reaffirmed_from !== null}
										(reaffirmed v{cv.reaffirmed_from})
									{/if}
									· {actorLabel(cv.actor)} ·
									<span title={new Date(cv.created_at).toLocaleString()}>{relativeTime(cv.created_at)}</span>
								</p>
							</div>
							<div class="flex shrink-0 items-center gap-1">
								{#if stale}
									<Button
										size="sm"
										variant="outline"
										disabled={busy}
										onclick={() => reaffirm(artifact)}
										title="This still stands — bless the current content as fresh"
									>
										<IconCheck size={14} /> Reaffirm
									</Button>
								{/if}
								<Button
									size="icon"
									variant="ghost"
									class="text-muted-foreground size-8"
									onclick={() => openAttach(artifact)}
									aria-label={`Attach a new version of ${artifact.name}`}
									title="Attach a new version"
								>
									<IconRefresh size={15} />
								</Button>
								<Button
									size="icon"
									variant="ghost"
									class="text-muted-foreground size-8"
									onclick={() => toggleHistory(artifact)}
									aria-label={`Version history of ${artifact.name}`}
									title="Version history"
								>
									<IconHistory size={15} />
								</Button>
								<Button
									size="icon"
									variant="ghost"
									class="text-muted-foreground hover:text-destructive size-8"
									disabled={busy}
									onclick={() => remove(artifact)}
									aria-label={`Delete ${artifact.name}`}
									title="Delete (all versions)"
								>
									<IconTrash size={15} />
								</Button>
							</div>
						</div>

						{#if openPreview === artifact.id && (artifact.artifact_type === 'file' || artifact.artifact_type === 'text')}
							<div class="mt-2 rounded-md border p-3" transition:slide={{ duration: dur() }}>
								{#if previewKind(artifact) === 'image'}
									<img
										src={contentUrl(artifact.name, { inline: true })}
										alt={cv.filename ?? artifact.name}
										class="max-h-96 rounded"
									/>
								{:else if previewKind(artifact) === 'markdown'}
									{#if textPreviews[artifact.id] !== undefined}
										<Markdown source={textPreviews[artifact.id]} class="text-sm" />
									{:else}
										<p class="text-muted-foreground text-xs">Loading…</p>
									{/if}
								{:else if previewKind(artifact) === 'text'}
									{#if textPreviews[artifact.id] !== undefined}
										<pre class="max-h-96 overflow-auto text-xs">{textPreviews[artifact.id]}</pre>
									{:else}
										<p class="text-muted-foreground text-xs">Loading…</p>
									{/if}
								{:else}
									<a
										href={contentUrl(artifact.name)}
										class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
									>
										<IconDownload size={13} />
										Download {cv.filename} ({cv.content_type})
									</a>
								{/if}
							</div>
						{/if}

						{#if openHistory === artifact.id}
							<div class="mt-2 rounded-md border" transition:slide={{ duration: dur() }}>
								{#if histories[artifact.id]}
									<ul class="divide-y">
										{#each histories[artifact.id] as v (v.version)}
											<li class="text-muted-foreground flex items-center gap-2 px-3 py-1.5 text-xs">
												<span class="text-foreground font-medium">v{v.version}</span>
												{#if v.reaffirmed_from !== null}
													<span>reaffirmed v{v.reaffirmed_from}</span>
												{/if}
												<span class="min-w-0 truncate">{actorLabel(v.actor)}</span>
												<span title={new Date(v.created_at).toLocaleString()}>{relativeTime(v.created_at)}</span>
												<span class="ml-auto flex items-center gap-2">
													{#if artifact.artifact_type === 'file' || artifact.artifact_type === 'text'}
														<a
															href={contentUrl(artifact.name, { version: v.version })}
															class="hover:text-foreground inline-flex items-center gap-1"
															title={`Download v${v.version}`}
														>
															<IconDownload size={12} />
															{v.filename}
														</a>
													{:else if artifact.artifact_type === 'link'}
														<a href={v.url} target="_blank" rel="noreferrer noopener" class="hover:text-foreground truncate">
															{v.url}
														</a>
													{:else}
														<a href={prUrl(v)} target="_blank" rel="noreferrer noopener" class="hover:text-foreground">
															{prRef(v)}
														</a>
													{/if}
												</span>
											</li>
										{/each}
									</ul>
								{:else}
									<p class="text-muted-foreground px-3 py-2 text-xs">Loading…</p>
								{/if}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</section>

<Modal
	open={attachOpen}
	onclose={() => (attachOpen = false)}
	title={attachTo ? `Attach a new version of “${attachTo.name}”` : 'Attach artifact'}
>
	<form class="space-y-3" onsubmit={submitAttach}>
		{#if !attachTo}
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="artifact-name">Name</label>
				<Input id="artifact-name" bind:value={attachName} placeholder="design-doc" />
				<p class="text-muted-foreground text-xs">
					Slug-like ([a-z0-9-]) — the slot name transition requirements match on. Re-attaching to an
					existing name appends a new version.
				</p>
			</div>
			<div class="space-y-1.5">
				<span class="text-sm font-medium">Type</span>
				<div class="flex flex-wrap gap-1.5">
					{#each ['file', 'text', 'link', 'pr'] as const as t (t)}
						{@const TypeIcon = typeIcons[t]}
						<label
							class="flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm {attachType === t
								? 'border-primary bg-primary/5'
								: 'hover:bg-muted/50'}"
						>
							<input type="radio" name="artifact-type" value={t} bind:group={attachType} class="sr-only" />
							<TypeIcon size={14} stroke={1.75} />
							{t}
						</label>
					{/each}
				</div>
			</div>
		{/if}

		{#if attachType === 'file'}
			<div
				class="rounded-md border border-dashed p-4 text-center text-sm {dragOver ? 'bg-muted/50' : ''}"
				role="group"
				aria-label="File drop zone"
				ondragover={(e) => {
					e.preventDefault();
					dragOver = true;
				}}
				ondragleave={() => (dragOver = false)}
				ondrop={(e) => {
					e.preventDefault();
					dragOver = false;
					attachFile = e.dataTransfer?.files?.[0] ?? attachFile;
				}}
			>
				{#if attachFile}
					<p class="font-medium">{attachFile.name}</p>
					<p class="text-muted-foreground text-xs">
						{attachFile.type || 'application/octet-stream'} · {attachFile.size.toLocaleString()} bytes
					</p>
				{:else}
					<p class="text-muted-foreground">Drop a file here, or</p>
				{/if}
				<label class="mt-2 inline-block cursor-pointer text-sm underline">
					{attachFile ? 'pick a different file' : 'pick a file'}
					<input
						type="file"
						class="sr-only"
						onchange={(e) => (attachFile = e.currentTarget.files?.[0] ?? null)}
					/>
				</label>
			</div>
		{:else if attachType === 'text'}
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="artifact-text">Document (Markdown)</label>
				<Textarea id="artifact-text" bind:value={attachText} rows={8} placeholder="# Design…" />
			</div>
		{:else if attachType === 'link'}
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="artifact-url">URL</label>
				<Input id="artifact-url" bind:value={attachUrl} placeholder="https://…" />
			</div>
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="artifact-title">Title (optional)</label>
				<Input id="artifact-title" bind:value={attachTitle} placeholder="Design review thread" />
			</div>
		{:else}
			<div class="space-y-1.5">
				<label class="text-sm font-medium" for="artifact-pr">Pull request</label>
				<Input id="artifact-pr" bind:value={attachPr} placeholder="owner/repo#123 or a PR URL" />
			</div>
		{/if}

		<div class="space-y-1.5">
			<label class="text-sm font-medium" for="artifact-description">Description (optional)</label>
			<Input id="artifact-description" bind:value={attachDescription} placeholder="One-liner shown in lists and prompts" />
		</div>

		{#if attachError}
			<p class="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
				{attachError}
			</p>
		{/if}

		<div class="flex justify-end gap-2">
			<Button type="button" variant="ghost" onclick={() => (attachOpen = false)}>Cancel</Button>
			<Button type="submit" disabled={!attachReady || attaching}>
				{attaching ? 'Attaching…' : attachTo ? `Attach v${attachTo.current_version.version + 1}` : 'Attach'}
			</Button>
		</div>
	</form>
</Modal>
