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
		...(first.rest ? [{ body: first.rest, scope: parts[0]?.scope }] : []),
		...parts.slice(1)
	]);
	const roundSummary = $derived(
		issue.round
			? `${issue.round.run_count} runs · ${issue.round.stages.length} stages${shots.length ? ` · ${shots.length} screenshots` : ''}`
			: ''
	);
	const clarificationArtifact = $derived(
		issue.state.name === 'Needs Clarification'
			? (artifacts.find((artifact) => artifact.name === 'clarification-request') ?? null)
			: null
	);
	let clarification = $state<{ status: 'loading' | 'loaded' | 'failed'; body?: string }>({
		status: 'loading'
	});
	$effect(() => {
		const artifact = clarificationArtifact;
		if (!artifact) return;
		let stale = false;
		clarification = { status: 'loading' };
		api
			.getArtifactContent(issue.id, artifact.name, { version: artifact.current_version.version })
			.then((content) => {
				if (!stale)
					clarification = {
						status: 'loaded',
						body: new TextDecoder().decode(content.bytes)
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
						<div class="text-sm"><Markdown source={part.body} /></div>
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
			Waiting {ageLabel(issue.state_entered_at)}
		</time>
		{#if issue.arrived_via}
			· {issue.arrived_via.action
				? `Arrived via ${issue.arrived_via.action}`
				: 'Moved directly'}{/if}
	</p>
	{#if issue.state.name === 'Needs Clarification'}
		<section class="bg-muted/40 mb-4 rounded-md border p-3">
			<h3 class="mb-2 text-sm font-semibold">Clarification requested</h3>
			{#if !clarificationArtifact}
				<p class="text-muted-foreground text-sm">No clarification request attached.</p>
			{:else if clarification.status === 'loaded'}
				<div class="text-sm"><Markdown source={clarification.body ?? ''} /></div>
			{:else if clarification.status === 'failed'}
				<p class="text-destructive text-sm">Couldn’t load the clarification request.</p>
				<button
					type="button"
					class="mt-2 text-xs underline"
					onclick={() =>
						openArtifact(clarificationArtifact.name, clarificationArtifact.current_version.version)}
					>Open artifact</button
				>
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
						<div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
							{#each shots as path (path)}
								<button
									class="min-w-0 text-left"
									type="button"
									onclick={() => openArtifact('screenshots', screenshots!.to_version, path)}
									aria-label="Open {path}, screenshots version {screenshots.to_version}"
								>
									<span class="bg-muted block aspect-4/3 overflow-hidden rounded border">
										<img
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
										/>
									</span>
									<span class="text-muted-foreground mt-1 block truncate text-xs"
										>{path.split('/').at(-1)}</span
									>
								</button>
							{/each}
						</div>
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
