<script lang="ts">
	import {
		ageLabel,
		type AllowedTransition,
		type Artifact,
		type ArtifactRequirementCheck,
		type EffectivePromptPart,
		type IssueDetail
	} from '@tines/shared';
	import ArtifactViewerDialog from '$lib/components/ArtifactViewerDialog.svelte';
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import HandoffRun from '$lib/components/HandoffRun.svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import PhoneFold from '$lib/components/PhoneFold.svelte';
	import TransitionList from '$lib/components/TransitionList.svelte';
	import {
		artifactContentUrl,
		displayStages,
		latestScreenshots,
		screenshotPaths,
		splitBrief,
		transitionMeanings
	} from '$lib/handoff';

	type Brief = { status: 'ready'; parts: EffectivePromptPart[] } | { status: 'unavailable' } | null;
	let {
		issue,
		artifacts,
		brief,
		transitions,
		unmetFor,
		disabled = false,
		disabledReason = null,
		onmove
	}: {
		issue: IssueDetail;
		artifacts: Artifact[];
		brief: Brief;
		transitions: AllowedTransition[];
		unmetFor: (transition: AllowedTransition) => ArtifactRequirementCheck[];
		disabled?: boolean;
		disabledReason?: string | null;
		onmove: (transition: AllowedTransition) => void;
	} = $props();

	const parts = $derived(brief?.status === 'ready' ? brief.parts : []);
	const first = $derived(splitBrief(parts[0]?.body ?? ''));
	const meanings = $derived(transitionMeanings(parts, transitions));
	const comments = $derived(new Map(issue.comments.map((comment) => [comment.id, comment])));
	const stages = $derived(issue.round ? displayStages(issue.round) : []);
	const screenshots = $derived(issue.round ? latestScreenshots(issue.round) : null);
	const shots = $derived(screenshots ? screenshotPaths(screenshots) : []);
	const restParts = $derived([
		...(first.rest ? [{ body: first.rest, scopeLabel: null }] : []),
		...parts.slice(1).map((part) => ({ body: part.body, scopeLabel: part.scope.label }))
	]);
	const roundSummary = $derived(
		issue.round
			? `${issue.round.run_count} runs · ${issue.round.stages.length} stages${shots.length ? ` · ${shots.length} screenshots` : ''}`
			: ''
	);
	let now = $state(Date.now());
	onMount(() => {
		const timer = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(timer);
	});
	const clarificationArtifact = $derived(
		issue.state.name === 'Needs Clarification'
			? (artifacts.find((artifact) => artifact.name === 'clarification-request') ?? null)
			: null
	);
	const clarificationInRound = $derived.by(() => {
		for (const stage of issue.round?.stages ?? [])
			for (const run of stage.runs)
				if (run.artifacts.some((artifact) => artifact.name === 'clarification-request'))
					return true;
		return false;
	});
	const clarificationVersion = $derived.by(() => {
		let selected: number | null = null;
		for (const stage of issue.round?.stages ?? [])
			for (const run of stage.runs)
				for (const artifact of run.artifacts)
					if (
						artifact.name === 'clarification-request' &&
						(selected === null || artifact.to_version > selected)
					)
						selected = artifact.to_version;
		return selected ?? clarificationArtifact?.current_version.version ?? null;
	});
	let clarificationRetry = $state(0);
	let clarification = $state<{
		status: 'loading' | 'loaded' | 'unsupported' | 'failed';
		body?: string;
		contentType?: string | null;
	}>({
		status: 'loading'
	});
	$effect(() => {
		const artifact = clarificationArtifact;
		const version = clarificationVersion;
		clarificationRetry;
		if (!artifact || version === null) return;
		let stale = false;
		clarification = { status: 'loading' };
		api
			.getArtifact(issue.id, artifact.name)
			.then(async (detail) => {
				const selected = detail.versions.find((candidate) => candidate.version === version);
				const contentType = selected?.content_type ?? null;
				if (contentType !== 'text/markdown' && contentType !== 'text/plain') {
					if (!stale) clarification = { status: 'unsupported', contentType };
					return;
				}
				const content = await api.getArtifactContent(issue.id, artifact.name, { version });
				if (!stale)
					clarification = {
						status: 'loaded',
						body: new TextDecoder().decode(content.bytes),
						contentType
					};
			})
			.catch(() => {
				if (!stale) clarification = { status: 'failed' };
			});
		return () => {
			stale = true;
		};
	});
	let viewerOpen = $state(false);
	let viewerName = $state<string | null>(null);
	let viewerVersion = $state<number | null>(null);
	let viewerPath = $state<string | null>(null);
	let failedShots = $state<Record<string, boolean>>({});
	function openArtifact(name: string, version: number, path?: string) {
		viewerName = name;
		viewerVersion = version;
		viewerPath = path ?? null;
		viewerOpen = true;
	}
</script>

<section
	class="rounded-lg border p-4 max-sm:mb-6 max-sm:border-x-0 max-sm:px-0"
	data-testid="handoff-card"
>
	<h2 class="mb-3 text-sm font-semibold">Handoff · {issue.state.name}</h2>
	<p class="text-muted-foreground mb-1 text-xs font-medium">From the workflow</p>
	{#if brief?.status === 'unavailable'}
		<p class="text-sm font-medium">Brief unavailable</p>
		<p class="text-muted-foreground text-xs">
			Couldn’t load this state’s instructions. Refresh to retry.
		</p>
	{:else if first.lead}
		<div class="text-sm"><Markdown source={first.lead} /></div>
		{#if restParts.length}
			<details class="mt-2">
				<summary class="text-muted-foreground cursor-pointer text-xs"
					>More from the workflow</summary
				>
				<div class="mt-3 space-y-4">
					{#each restParts as part}
						<div>
							{#if part.scopeLabel}
								<p class="text-muted-foreground mb-1 text-xs font-medium">{part.scopeLabel}</p>
							{/if}
							<div class="text-sm"><Markdown source={part.body} /></div>
						</div>
					{/each}
				</div>
			</details>
		{/if}
	{:else}
		<p class="text-sm font-medium">Brief unavailable</p>
		<p class="text-muted-foreground text-xs">This state has no instructions to display.</p>
	{/if}

	<p class="text-muted-foreground my-3 text-xs">
		<time
			datetime={new Date(issue.state_entered_at).toISOString()}
			title={new Date(issue.state_entered_at).toLocaleString()}
		>
			Waiting {ageLabel(issue.state_entered_at, now)}
		</time>
		{#if issue.arrived_via}
			· {issue.arrived_via.action
				? `Arrived via ${issue.arrived_via.action}`
				: 'Moved directly'}{/if}
	</p>
	{#if issue.state.name === 'Needs Clarification'}
		<section class="bg-muted/40 mb-4 rounded-md border p-3">
			<h3 class="mb-2 text-sm font-semibold">
				{clarificationInRound
					? 'Clarification requested'
					: 'Current clarification-request'}{#if clarificationVersion !== null}
					· v{clarificationVersion}{/if}
			</h3>
			{#if !clarificationArtifact}
				<p class="text-muted-foreground text-sm">No clarification request attached.</p>
			{:else if clarification.status === 'loaded' && clarification.contentType === 'text/markdown'}
				<div class="text-sm"><Markdown source={clarification.body ?? ''} /></div>
			{:else if clarification.status === 'loaded'}
				<pre class="overflow-x-auto text-sm whitespace-pre-wrap">{clarification.body ?? ''}</pre>
			{:else if clarification.status === 'unsupported'}
				<p class="text-muted-foreground text-sm">
					This artifact type can’t be shown inline{clarification.contentType
						? ` (${clarification.contentType})`
						: ''}.
				</p>
				<button
					type="button"
					class="mt-2 text-xs underline"
					onclick={() =>
						openArtifact(
							clarificationArtifact.name,
							clarificationVersion ?? clarificationArtifact.current_version.version
						)}>Open artifact</button
				>
			{:else if clarification.status === 'failed'}
				<p class="text-destructive text-sm">Couldn’t load the clarification request.</p>
				<div class="mt-2 flex gap-3">
					<button type="button" class="text-xs underline" onclick={() => (clarificationRetry += 1)}
						>Retry</button
					>
					<button
						type="button"
						class="text-xs underline"
						onclick={() =>
							openArtifact(
								clarificationArtifact.name,
								clarificationVersion ?? clarificationArtifact.current_version.version
							)}>Open artifact</button
					>
				</div>
			{:else}
				<p class="text-muted-foreground text-sm">Loading clarification request…</p>
			{/if}
		</section>
	{/if}

	<div class="mb-5 max-sm:hidden">
		<TransitionList
			{transitions}
			{unmetFor}
			{disabled}
			{disabledReason}
			stateEnteredAt={issue.state_entered_at}
			{meanings}
			wrapLabels
			{onmove}
		/>
	</div>

	{#if issue.round}
		<PhoneFold title="What came back" summary={roundSummary}>
			<div class="space-y-5 border-t pt-4 sm:mt-4">
				{#each stages as stage (stage.state.id)}
					<section class="space-y-3">
						<h3 class="text-sm font-semibold">{stage.state.name ?? 'Former stage'}</h3>
						<HandoffRun run={stage.runs[0]} {comments} onartifact={openArtifact} />
						{#if stage.runs.length > 1}
							<details>
								<summary class="text-muted-foreground cursor-pointer text-xs">
									{stage.runs.length - 1} earlier attempt{stage.runs.length === 2
										? ''
										: 's'}{#if stage.runs.length === 2 && stage.runs[1].returned_via?.action}
										· returned via {stage.runs[1].returned_via.action}{/if}
								</summary>
								<div class="mt-3 space-y-5 border-l pl-3">
									{#each stage.runs.slice(1) as run (run.run_id)}
										<HandoffRun {run} {comments} onartifact={openArtifact} />
									{/each}
								</div>
							</details>
						{/if}
					</section>
				{/each}
				{#if screenshots}
					<section>
						<h3 class="mb-2 text-sm font-semibold">Screenshots · v{screenshots.to_version}</h3>
						{#if shots.length}
							<div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
								{#each shots as path (path)}
									<button
										class="min-w-0 text-left"
										type="button"
										onclick={() => openArtifact('screenshots', screenshots!.to_version, path)}
										aria-label="Open {path}, screenshots version {screenshots.to_version}"
									>
										<span
											class="bg-muted flex aspect-4/3 items-center justify-center overflow-hidden rounded border"
										>
											{#if failedShots[path]}
												<span class="text-muted-foreground px-2 text-center text-xs">
													{path.split('/').at(-1)} · open file
												</span>
											{:else}<img
													src={artifactContentUrl(
														issue.id,
														'screenshots',
														screenshots.to_version,
														path
													)}
													alt={path}
													class="size-full object-contain"
													loading="lazy"
													decoding="async"
													onerror={() => (failedShots = { ...failedShots, [path]: true })}
												/>{/if}
										</span>
										<span class="text-muted-foreground mt-1 block truncate text-xs"
											>{path.split('/').at(-1)}</span
										>
									</button>
								{/each}
							</div>
						{:else}
							<ul class="text-muted-foreground space-y-1 text-xs">
								{#each screenshots.files ?? [] as path (path)}
									<li class="break-all">{path}</li>
								{/each}
							</ul>
						{/if}
						{#if (screenshots.files?.length ?? 0) > shots.length}
							<button
								type="button"
								class="text-muted-foreground mt-2 text-xs underline"
								onclick={() => openArtifact('screenshots', screenshots!.to_version)}
							>
								+{(screenshots.files?.length ?? 0) - shots.length} more files
							</button>
						{/if}
					</section>
				{/if}
				{#if issue.since_last_run}
					<details class="border-t pt-3">
						<summary class="text-muted-foreground cursor-pointer text-xs font-medium"
							>Since the last run</summary
						>
						<div class="mt-3 space-y-3">
							{#if issue.since_last_run.transition}
								<p class="text-muted-foreground text-xs">
									{issue.since_last_run.transition.action ?? 'Moved directly'} · {issue
										.since_last_run.transition.actor.user_name ?? 'A user'}
								</p>
							{/if}
							{#each issue.since_last_run.comments as comment (comment.id)}
								<div class="text-sm"><Markdown source={comment.body} /></div>
							{/each}
							{#if issue.since_last_run.comment_count > issue.since_last_run.comments.length}
								<p class="text-muted-foreground text-xs">
									Showing {issue.since_last_run.comments.length} of {issue.since_last_run
										.comment_count} comments.
								</p>
							{/if}
							{#if issue.since_last_run.stale_artifacts.length}
								<p class="text-muted-foreground text-xs">
									Stale artifacts: {issue.since_last_run.stale_artifacts.join(', ')}
								</p>
							{/if}
						</div>
					</details>
				{/if}
			</div>
		</PhoneFold>
	{:else}
		<p class="text-muted-foreground border-t pt-4 text-sm">No agent work in this round.</p>
	{/if}
</section>

<ArtifactViewerDialog
	issueId={issue.id}
	{artifacts}
	bind:open={viewerOpen}
	bind:selectedName={viewerName}
	initialVersion={viewerVersion}
	initialPath={viewerPath}
/>
