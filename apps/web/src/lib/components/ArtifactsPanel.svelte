<script lang="ts">
	import type { AllowedTransition, Artifact, ArtifactType } from '@tines/shared';
	import { ApiError, ARTIFACT_NAME_PATTERN, parsePrSpec } from '@tines/shared';
	import IconCheck from '@tabler/icons-svelte/icons/check';
	import IconExternalLink from '@tabler/icons-svelte/icons/external-link';
	import IconEye from '@tabler/icons-svelte/icons/eye';
	import IconFile from '@tabler/icons-svelte/icons/file';
	import IconFileText from '@tabler/icons-svelte/icons/file-text';
	import IconFolder from '@tabler/icons-svelte/icons/folder';
	import IconGitPullRequest from '@tabler/icons-svelte/icons/git-pull-request';
	import IconLink from '@tabler/icons-svelte/icons/link';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import IconRefresh from '@tabler/icons-svelte/icons/refresh';
	import IconTrash from '@tabler/icons-svelte/icons/trash';
	import { slide } from 'svelte/transition';
	import { api } from '$lib/api';
	import {
		attachGateHint,
		attachGateWarning,
		effectiveContentType,
		gatesForName
	} from '$lib/artifact-gates';
	import ArtifactViewerDialog from '$lib/components/ArtifactViewerDialog.svelte';
	import { confirmDialog } from '$lib/components/dialogs.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { actorLabel, prefersReducedMotion, relativeTime } from '$lib/format';

	let {
		issueId,
		artifacts,
		allowedTransitions,
		disabledReason = null,
		onchanged,
		onerror
	}: {
		issueId: string;
		artifacts: Artifact[];
		/** For the requirement-relevant stale badge (allowed moves' requires). */
		allowedTransitions: AllowedTransition[];
		/** When set, every mutating control renders disabled with this as its tooltip. */
		disabledReason?: string | null;
		onchanged: () => void | Promise<void>;
		onerror: (e: unknown) => void;
	} = $props();

	const readOnly = $derived(disabledReason != null);

	const dur = () => (prefersReducedMotion() ? 0 : 180);

	const typeIcons = {
		file: IconFile,
		folder: IconFolder,
		text: IconFileText,
		link: IconLink,
		pr: IconGitPullRequest
	} as const;

	/** Slots some transition out of the current state requires — only those
	 * get nagged with a stale badge (incidental attachments do not). */
	const requiredSlots = $derived(
		new Set(allowedTransitions.flatMap((t) => (t.requires ?? []).map((r) => r.artifact)))
	);

	const contentUrl = (name: string, opts: { path?: string } = {}) => {
		const params = new URLSearchParams({ inline: '1' });
		if (opts.path !== undefined) params.set('path', opts.path);
		return `/api/v1/issues/${issueId}/artifacts/${encodeURIComponent(name)}/content?${params.toString()}`;
	};

	const prUrl = (a: Artifact) =>
		`${a.current_version.pr_repo_url}/pull/${a.current_version.pr_number}`;
	const prRef = (a: Artifact) =>
		`${(a.current_version.pr_repo_url ?? '').replace(/^https:\/\/github\.com\//, '')}#${a.current_version.pr_number}`;

	/** Rows stay compact; the one inline survivor is the image thumbnail — the
	 * genuinely glanceable case. Only the first shows on a phone, where the
	 * full strip would leave the text column nothing to live on. */
	function thumbnails(a: Artifact): { path?: string }[] {
		if (a.artifact_type === 'file' && (a.current_version.content_type ?? '').startsWith('image/')) {
			return [{}];
		}
		if (a.artifact_type === 'folder') {
			return (a.current_version.files ?? [])
				.filter((f) => f.content_type.startsWith('image/'))
				.slice(0, 3)
				.map((f) => ({ path: f.path }));
		}
		return [];
	}

	function summaryLabel(a: Artifact): string | null {
		const cv = a.current_version;
		switch (a.artifact_type) {
			case 'file':
			case 'text':
				return cv.filename;
			case 'folder':
				return `${cv.file_count} file${cv.file_count === 1 ? '' : 's'}`;
			default:
				return null;
		}
	}

	// --- viewer -----------------------------------------------------------------

	let viewerOpen = $state(false);
	let viewerName = $state<string | null>(null);

	function openViewer(a: Artifact) {
		viewerName = a.name;
		viewerOpen = true;
	}

	// --- mutations ----------------------------------------------------------------

	let busy = $state(false);

	async function reaffirm(a: Artifact) {
		if (busy) return;
		busy = true;
		try {
			await api.reaffirmArtifact(issueId, a.name);
			await onchanged();
		} catch (e) {
			onerror(e);
		} finally {
			busy = false;
		}
	}

	async function remove(a: Artifact) {
		if (busy) return;
		const ok = await confirmDialog({
			title: `Delete artifact "${a.name}"?`,
			body: `All ${a.version_count} version${a.version_count === 1 ? '' : 's'} of it will be deleted.`,
			confirmLabel: 'Delete artifact',
			destructive: true
		});
		if (!ok || busy) return;
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
	let attachFolderFiles = $state<File[]>([]);
	let attachText = $state('');
	let attachUrl = $state('');
	let attachTitle = $state('');
	let attachPr = $state('');
	let attachError = $state<string | null>(null);
	let attaching = $state(false);
	let dragOver = $state(false);
	/**
	 * The gate set the operator's last hand pick was made against. A pick wins
	 * over the pre-selection while the name keeps matching the same gates; when
	 * the typed name matches a *different* gate set the pre-selection re-arms,
	 * which is what "not chosen one by hand since the name last matched" means.
	 * Null until they pick.
	 */
	let pickedFor = $state<string | null>(null);

	/**
	 * The requirements on this slot, live as the name is typed — the same gates
	 * the CLI reads, so the dialog pre-selects what `attach` would have inferred.
	 * An existing artifact's name is the locked one.
	 */
	const attachGates = $derived(
		gatesForName(allowedTransitions, attachTo?.name ?? attachName.trim())
	);
	/** Only a new artifact gets a pre-selection: an existing slot's type is immutable. */
	const gateHint = $derived(attachTo ? null : attachGateHint(attachGates));
	/** The concrete MIME the gate asks for, declared with the write. */
	const gateContentType = $derived(
		attachGateHint(attachGates.filter((g) => g.check.type === attachType))?.contentType
	);
	/** Exactly what the file branch of `submitAttach` will declare, or nothing yet. */
	const attachFileType = $derived(
		attachFile ? attachFile.type || 'application/octet-stream' : undefined
	);
	const gateWarning = $derived(
		attachGateWarning(
			attachGates,
			attachType,
			effectiveContentType(attachType, gateContentType, attachFileType)
		)
	);
	/** Identity of the gates on the typed name — the pre-selection re-arms when it changes. */
	const gateKey = $derived(
		attachGates
			.map((g) => `${g.transition}:${g.check.type ?? ''}:${g.check.content_type ?? ''}`)
			.join('|')
	);
	const typePicked = $derived(pickedFor !== null && pickedFor === gateKey);

	/**
	 * Flip the selector to the gate's type as the name is typed. Reads
	 * `attachType` so the effect settles after its own write; `typePicked`
	 * stops it re-asserting over a type picked against these same gates
	 * (which would silently revert the operator on the next keystroke).
	 */
	$effect(() => {
		const wanted = gateHint?.type;
		if (wanted !== undefined && !typePicked && attachType !== wanted) attachType = wanted;
	});

	function openAttach(existing: Artifact | null) {
		attachTo = existing;
		attachName = existing?.name ?? '';
		attachType = existing?.artifact_type ?? 'file';
		attachDescription = existing?.description ?? '';
		attachFile = null;
		attachFolderFiles = [];
		attachText = '';
		attachUrl = existing?.artifact_type === 'link' ? (existing.current_version.url ?? '') : '';
		attachTitle = '';
		attachPr = '';
		attachError = null;
		pickedFor = null;
		attachOpen = true;
	}

	const attachReady = $derived.by(() => {
		if (!ARTIFACT_NAME_PATTERN.test(attachName)) return false;
		switch (attachType) {
			case 'file':
				return attachFile !== null;
			case 'folder':
				return attachFolderFiles.length > 0;
			case 'text':
				return attachText.trim().length > 0;
			case 'link':
				return attachUrl.trim().length > 0;
			case 'pr':
				return parsePrSpec(attachPr) !== null;
		}
	});

	/**
	 * Snapshot paths from a directory pick: webkitRelativePath includes the
	 * picked folder itself as the first segment — strip it when every file
	 * shares it, so paths are folder-relative. Plain multi-file drops carry
	 * no relative path and land flat under their names.
	 */
	function folderEntryPath(file: File): string {
		const rel = file.webkitRelativePath;
		if (!rel) return file.name;
		const cut = rel.indexOf('/');
		return cut > 0 ? rel.slice(cut + 1) : rel;
	}

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
			} else if (attachType === 'folder') {
				const files = await Promise.all(
					attachFolderFiles.map(async (file) => ({
						path: folderEntryPath(file),
						contentType: file.type || 'application/octet-stream',
						bytes: await file.arrayBuffer()
					}))
				);
				await api.uploadArtifactFolder(issueId, attachName, files);
				if (description !== undefined) {
					await api.putArtifact(issueId, attachName, { description });
				}
			} else if (attachType === 'text') {
				await api.putArtifact(issueId, attachName, {
					type: 'text',
					content: attachText,
					description,
					...(gateContentType !== undefined ? { content_type: gateContentType } : {})
				});
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
			await onchanged();
		} catch (err) {
			attachError = err instanceof ApiError ? err.message : 'Something went wrong — try again.';
		} finally {
			attaching = false;
		}
	}
</script>

<section id="artifacts" class="rounded-lg border">
	<header class="flex items-center justify-between border-b px-4 py-2.5">
		<h2 class="text-sm font-semibold">
			Artifacts
			{#if artifacts.length > 0}
				<span class="text-muted-foreground font-normal">({artifacts.length})</span>
			{/if}
		</h2>
		<Button
			size="sm"
			variant="ghost"
			onclick={() => openAttach(null)}
			disabled={readOnly}
			title={disabledReason}
		>
			<IconPlus size={14} /> Attach artifact
		</Button>
	</header>
	<div class="p-4">
		{#if artifacts.length === 0}
			<p class="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
				No artifacts attached — attach the work products this issue produces (documents, screenshot
				folders, links, PRs). Workflow transitions can require them.
			</p>
		{:else}
			<ul class="divide-y rounded-lg border">
				{#each artifacts as artifact (artifact.id)}
					{@const TypeIcon = typeIcons[artifact.artifact_type]}
					{@const stale = !artifact.fresh && requiredSlots.has(artifact.name)}
					{@const cv = artifact.current_version}
					{@const thumbs = thumbnails(artifact)}
					<!-- Wraps rather than crushing the text column: the icon, thumbnails and
					     actions cannot shrink, so on a phone the text was the only thing left to
					     give (measured 14px, 0px with a Reaffirm button). `basis-40` makes the
					     text claim a readable width first, pushing the actions onto their own
					     right-aligned line instead. -->
					<li
						class="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5"
						transition:slide={{ duration: dur() }}
					>
						<span class="text-muted-foreground shrink-0" title={artifact.artifact_type}>
							<TypeIcon size={16} stroke={1.75} />
						</span>
						{#if thumbs.length > 0}
							<button
								type="button"
								class="flex shrink-0 gap-1"
								onclick={() => openViewer(artifact)}
								aria-label={`View ${artifact.name}`}
							>
								{#each thumbs as thumb, i (thumb.path ?? '')}
									<img
										src={contentUrl(artifact.name, { path: thumb.path })}
										alt={thumb.path ?? artifact.name}
										loading="lazy"
										class="h-10 w-10 rounded border object-cover {i > 0 ? 'hidden sm:block' : ''}"
									/>
								{/each}
							</button>
						{/if}
						<div class="min-w-0 grow basis-40">
							<div class="flex flex-wrap items-center gap-2 text-sm">
								<button
									type="button"
									class="font-medium hover:underline"
									onclick={() => openViewer(artifact)}
								>
									{artifact.name}
								</button>
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
										href={prUrl(artifact)}
										target="_blank"
										rel="noreferrer noopener"
										class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
									>
										<IconExternalLink size={12} />
										{prRef(artifact)}
									</a>
								{:else if summaryLabel(artifact)}
									<span class="text-muted-foreground truncate text-xs"
										>{summaryLabel(artifact)}</span
									>
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
								<span title={new Date(cv.created_at).toLocaleString()}
									>{relativeTime(cv.created_at)}</span
								>
							</p>
						</div>
						<div class="ml-auto flex shrink-0 items-center gap-1">
							{#if stale}
								<Button
									size="sm"
									variant="outline"
									disabled={busy || readOnly}
									onclick={() => reaffirm(artifact)}
									title={disabledReason ?? 'This still stands — bless the current content as fresh'}
								>
									<IconCheck size={14} /> Reaffirm
								</Button>
							{/if}
							<Button
								size="icon"
								variant="ghost"
								class="text-muted-foreground size-8"
								onclick={() => openViewer(artifact)}
								aria-label={`View ${artifact.name} (content and version history)`}
								title="View content and history"
							>
								<IconEye size={15} />
							</Button>
							<Button
								size="icon"
								variant="ghost"
								class="text-muted-foreground size-8"
								disabled={readOnly}
								onclick={() => openAttach(artifact)}
								aria-label={`Attach a new version of ${artifact.name}`}
								title={disabledReason ?? 'Attach a new version'}
							>
								<IconRefresh size={15} />
							</Button>
							<Button
								size="icon"
								variant="ghost"
								class="text-muted-foreground hover:text-destructive size-8"
								disabled={busy || readOnly}
								onclick={() => remove(artifact)}
								aria-label={`Delete ${artifact.name}`}
								title={disabledReason ?? 'Delete (all versions)'}
							>
								<IconTrash size={15} />
							</Button>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</section>

<ArtifactViewerDialog {issueId} {artifacts} bind:open={viewerOpen} bind:selectedName={viewerName} />

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
					{#each ['file', 'folder', 'text', 'link', 'pr'] as const as t (t)}
						{@const TypeIcon = typeIcons[t]}
						<label
							class="flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm {attachType ===
							t
								? 'border-primary bg-primary/5'
								: 'hover:bg-muted/50'}"
						>
							<input
								type="radio"
								name="artifact-type"
								value={t}
								checked={attachType === t}
								onchange={() => {
									attachType = t;
									pickedFor = gateKey;
								}}
								class="sr-only"
							/>
							<TypeIcon size={14} stroke={1.75} />
							{t}
						</label>
					{/each}
				</div>
				{#if gateHint}
					<p class="text-muted-foreground text-xs">
						Required by <span class="font-medium">{gateHint.transition}</span>
						({gateHint.spec}){#each gateHint.others as other (other.transition)}, and by <span
								class="font-medium">{other.transition}</span
							>
							({other.spec}){/each}.
					</p>
				{/if}
			</div>
		{/if}

		{#if gateWarning}
			<p
				class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
			>
				A {attachType} artifact cannot satisfy
				<span class="font-medium">{gateWarning.transition}</span>
				(needs {gateWarning.wants}){#each gateWarning.others as other (other)}, nor <span
						class="font-medium">{other}</span
					>{/each}{#if attachTo}{' '}— the type cannot change; delete and re-attach{/if}. Attaching
				is still allowed.
			</p>
		{/if}

		{#if attachType === 'file'}
			<div
				class="rounded-md border border-dashed p-4 text-center text-sm {dragOver
					? 'bg-muted/50'
					: ''}"
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
		{:else if attachType === 'folder'}
			<div
				class="rounded-md border border-dashed p-4 text-center text-sm {dragOver
					? 'bg-muted/50'
					: ''}"
				role="group"
				aria-label="Folder drop zone"
				ondragover={(e) => {
					e.preventDefault();
					dragOver = true;
				}}
				ondragleave={() => (dragOver = false)}
				ondrop={(e) => {
					e.preventDefault();
					dragOver = false;
					const dropped = [...(e.dataTransfer?.files ?? [])];
					if (dropped.length > 0) attachFolderFiles = dropped;
				}}
			>
				{#if attachFolderFiles.length > 0}
					<p class="font-medium">
						{attachFolderFiles.length} file{attachFolderFiles.length === 1 ? '' : 's'} ·
						{attachFolderFiles.reduce((n, f) => n + f.size, 0).toLocaleString()} bytes
					</p>
					<p class="text-muted-foreground max-h-24 overflow-y-auto text-xs">
						{attachFolderFiles.map(folderEntryPath).join(', ')}
					</p>
				{:else}
					<p class="text-muted-foreground">
						Drop files here (uploaded as one whole snapshot — the new version), or
					</p>
				{/if}
				<label class="mt-2 inline-block cursor-pointer text-sm underline">
					{attachFolderFiles.length > 0 ? 'pick a different folder' : 'pick a folder'}
					<input
						type="file"
						class="sr-only"
						webkitdirectory
						multiple
						onchange={(e) => (attachFolderFiles = [...(e.currentTarget.files ?? [])])}
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
			<Input
				id="artifact-description"
				bind:value={attachDescription}
				placeholder="One-liner shown in lists and prompts"
			/>
		</div>

		{#if attachError}
			<p
				class="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm"
			>
				{attachError}
			</p>
		{/if}

		<div class="flex flex-wrap justify-end gap-2">
			<Button
				type="button"
				variant="ghost"
				disabled={attaching}
				onclick={() => (attachOpen = false)}
			>
				Cancel
			</Button>
			<PendingButton
				type="submit"
				pending={attaching}
				pendingLabel="Attaching…"
				disabled={!attachReady}
			>
				{attachTo ? `Attach v${attachTo.current_version.version + 1}` : 'Attach'}
			</PendingButton>
		</div>
	</form>
</Modal>
