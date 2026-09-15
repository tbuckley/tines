<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import WorkflowGraph from '$lib/components/WorkflowGraph.svelte';
	import MarketingSignIn from '$lib/components/marketing/MarketingSignIn.svelte';
	import PublicTextSnippet from '$lib/components/publications/PublicTextSnippet.svelte';
	import PublicationReportDialog from '$lib/components/publications/PublicationReportDialog.svelte';
	import TechnicalDetails from '$lib/components/publications/TechnicalDetails.svelte';

	let { data } = $props();
	const snapshot = $derived(data.snapshot);
	const main = $derived(
		snapshot.document.workflows.find(
			(workflow) => workflow.id === snapshot.document.main_workflow_id
		)!
	);
	let available = $state(true);
	let checking = $state(false);
	let signIn = $state<MarketingSignIn>();
	let reportDialog = $state<PublicationReportDialog>();
	const installReturn = $derived(`/p/${snapshot.snapshot_id}/install`);
	const signInErrorReturn = $derived(`/p/${snapshot.snapshot_id}?install=1&error=signin`);
	const linkError = $derived(
		page.url.searchParams.get('error') === 'signin'
			? 'That sign-in link is invalid or has expired. Enter your email to get a new one.'
			: null
	);
	const visible = $derived(available && !checking);

	function stateName(id: string) {
		return (
			snapshot.document.workflows
				.flatMap((workflow) => workflow.states)
				.find((state) => state.id === id)?.name ?? id
		);
	}

	function workflowName(id: string) {
		return snapshot.document.workflows.find((workflow) => workflow.id === id)?.name ?? id;
	}

	function inputUses(id: string) {
		return snapshot.document.text_uses.filter((use) => use.input_id === id);
	}

	async function recheck() {
		if (checking || !available) return available;
		checking = true;
		try {
			const response = await fetch(`/api/v1/publications/public/${snapshot.snapshot_id}/status`, {
				cache: 'no-store'
			});
			if (!response.ok) available = false;
			else {
				const status = await response.json();
				if (status.status_version !== snapshot.status_version) available = false;
			}
		} catch {
			available = false;
		} finally {
			checking = false;
		}
		return available;
	}

	async function download() {
		if (await recheck())
			location.href = `/api/v1/publications/public/${snapshot.snapshot_id}/download`;
	}

	onMount(() => {
		const resumed = () => void recheck();
		const timer = setInterval(() => {
			if (!document.hidden) void recheck();
		}, 15_000);
		addEventListener('focus', resumed);
		addEventListener('pageshow', resumed);
		return () => {
			clearInterval(timer);
			removeEventListener('focus', resumed);
			removeEventListener('pageshow', resumed);
		};
	});
</script>

<svelte:head
	><title>{visible ? `${main.name} — Public workflow` : 'Publication unavailable'}</title><meta
		name="referrer"
		content="no-referrer"
	/><meta name="robots" content="noindex" /></svelte:head
>

{#if visible}
	<main class="mx-auto min-h-screen max-w-5xl min-w-0 overflow-x-hidden px-4 py-8 sm:px-6">
		<header class="border-b pb-6">
			<p class="text-muted-foreground text-sm">Shared workflow</p>
			<h1 class="mt-1 text-3xl font-semibold wrap-break-word">{main.name}</h1>
			<p class="text-muted-foreground mt-2 min-w-0 text-sm break-words">
				Published by {snapshot.metadata.display_name} · {snapshot.metadata.license} · this shared version
				will not change
			</p>
			<div class="mt-5 flex flex-wrap gap-3">
				<button
					class="rounded-md border px-4 py-2 font-medium"
					type="button"
					onclick={(event) => reportDialog?.show(event.currentTarget)}>Report</button
				>
				{#if data.user}<a
						class="bg-primary text-primary-foreground rounded-md px-4 py-2 font-medium"
						href="/workflows/import?publication={snapshot.snapshot_id}"
						data-sveltekit-preload-data="off">Install a copy</a
					>{:else}<button
						class="bg-primary text-primary-foreground rounded-md px-4 py-2 font-medium"
						onclick={(event) => signIn?.open(event.currentTarget)}>Sign in to install</button
					>{/if}
				<button class="rounded-md border px-4 py-2 font-medium" type="button" onclick={download}
					>Download file</button
				>
				<a
					class="rounded-md border px-4 py-2 font-medium"
					href="/api/v1/publications/public/{snapshot.snapshot_id}/reuse.txt"
					rel="noreferrer"
					data-sveltekit-reload>Reuse notice</a
				>
			</div>
		</header>

		<section class="py-6" aria-labelledby="summary">
			<h2 id="summary" class="text-xl font-semibold">What this workflow does</h2>
			<div class="mt-3">
				<PublicTextSnippet source={main.description || 'No description provided.'} />
			</div>
		</section>
		<section class="py-6" aria-labelledby="graph">
			<h2 id="graph" class="text-xl font-semibold">Workflow graph and gates</h2>
			<nav class="mt-3" aria-label="Bundled workflow dependencies">
				<ul class="flex min-w-0 flex-wrap gap-2 text-sm">
					{#each snapshot.document.workflows as workflow}<li class="min-w-0">
							<a
								class="text-primary block max-w-full break-words underline"
								href="#workflow-{workflow.id}">{workflow.name}</a
							>
						</li>{/each}
				</ul>
			</nav>
			{#each snapshot.document.workflows as workflow}<article
					class="mt-4 min-w-0 rounded-lg border p-4"
					id="workflow-{workflow.id}"
				>
					<h3 class="min-w-0 font-semibold break-words">
						{workflow.name}
						<span class="text-muted-foreground text-xs"
							>· {workflow.id === main.id ? 'main' : 'required dependency'}</span
						>
					</h3>
					<!-- A named horizontal scroll region is intentionally keyboard-focusable. -->
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<div
						class="focus-visible:ring-ring mt-3 max-w-full min-w-0 overflow-x-auto focus-visible:ring-2"
						tabindex="0"
						role="region"
						aria-label={`${workflow.name} graph; scroll horizontally to inspect all states`}
					>
						<WorkflowGraph {workflow} fit={false} intrinsicScale={1.3} />
					</div>
					<ul class="mt-3 flex min-w-0 flex-wrap gap-2 text-xs" aria-label="States">
						{#each workflow.states as state}<li
								class="bg-muted min-w-0 rounded px-2 py-1 break-words"
								id="state-{state.id}"
							>
								{state.name} · {state.category}{state.inherits_from
									? ` · inherits ${stateName(state.inherits_from.state_id)}`
									: ''}
							</li>{/each}
					</ul>
					<ul class="mt-4 min-w-0 space-y-2 text-sm">
						{#each workflow.transitions as transition}<li class="min-w-0 break-words">
								<b class="break-words">{transition.name}</b>{#if transition.requires.length}<ul
										class="min-w-0 list-disc pl-5"
									>
										{#each transition.requires as gate}<li class="min-w-0 break-words">
												{gate.artifact} · {gate.type}{gate.content_type
													? ` · ${gate.content_type}`
													: ''} — {gate.description}
											</li>{/each}
									</ul>{:else}<span class="text-muted-foreground"> · no artifact gate</span>{/if}
							</li>{/each}
					</ul>
				</article>{/each}
		</section>
		<section class="py-6" aria-labelledby="instructions">
			<h2 id="instructions" class="text-xl font-semibold">
				Complete instructions and declarations
			</h2>
			<div class="mt-4 space-y-4">
				{#each snapshot.document.context as item, contextIndex}<article
						class="min-w-0 overflow-hidden rounded-lg border p-4 break-words"
						id="context-{item.id}"
					>
						<h3 class="min-w-0 font-semibold break-words">
							{item.name} <span class="text-muted-foreground text-xs">· {item.kind}</span>
						</h3>
						<p class="text-muted-foreground mt-1 text-xs">
							{contextIndex + 1} in bundled instruction order · declared on {stateName(
								item.state_id
							)}
						</p>
						{#if item.description}<div class="mt-2">
								<PublicTextSnippet source={item.description} />
							</div>{/if}{#if item.kind === 'prompt'}<div class="mt-3">
								<PublicTextSnippet source={item.body} />
							</div>{:else if item.kind === 'skill'}{#each item.files as file}<section class="mt-3">
									<h4 class="font-mono text-sm">{file.path}</h4>
									{#if file.path.toLowerCase().endsWith('.txt')}<pre
											class="bg-muted mt-2 max-w-full overflow-x-auto rounded p-3 text-xs whitespace-pre-wrap">{file.content}</pre>{:else}<div
											class="mt-2"
										>
											<PublicTextSnippet source={file.content} />
										</div>{/if}
								</section>{/each}{:else}<dl
								class="mt-3 grid grid-cols-[5rem_minmax(0,1fr)] gap-1 text-sm"
							>
								<dt>URL</dt>
								<dd class="font-mono break-all">{item.repo_url}</dd>
								<dt>Branch</dt>
								<dd class="min-w-0 break-all">{item.repo_branch ?? 'default'}</dd>
								<dt>Directory</dt>
								<dd>{item.repo_dir ?? 'root'}</dd>
							</dl>
							<p class="text-muted-foreground mt-2 text-xs">
								Declaration only. Repository contents are never fetched.
							</p>{/if}
					</article>{/each}
			</div>
		</section>
		<section class="grid min-w-0 gap-4 py-6 md:grid-cols-2">
			<article class="min-w-0 rounded-lg border p-4">
				<h2 class="font-semibold">Inputs</h2>
				<ul class="mt-2 space-y-2 text-sm">
					{#each snapshot.document.inputs as input}<li
							class="min-w-0 break-words"
							id="input-{input.id}"
						>
							<code class="break-all">{input.key}</code> · {input.type} · {input.required
								? 'required'
								: 'optional'}<br />
							<span>{input.label}</span>{#if input.description}<span class="text-muted-foreground">
									— {input.description}</span
								>{/if}<br />
							<span class="text-muted-foreground break-all">Default: {input.default ?? 'none'}</span
							>
							{#if input.required_states?.length}<div class="mt-1">
									Required states: {input.required_states.join(', ')}
								</div>{/if}
							{#if inputUses(input.id).length}<ul class="mt-1 list-disc pl-5">
									{#each inputUses(input.id) as use}<li>
											<a
												class="text-primary break-all underline"
												href="#context-{use.target.record_id}">{use.token}</a
											>
											in {use.target.field}
										</li>{/each}
								</ul>{/if}
						</li>{/each}
				</ul>
			</article>
			<article class="min-w-0 rounded-lg border p-4">
				<h2 class="font-semibold">Selected automation</h2>
				<h3 class="mt-3 text-sm font-semibold">Schedules (installed paused)</h3>
				<ul class="mt-1 space-y-3 text-sm">
					{#each snapshot.document.schedules as schedule}<li class="min-w-0 break-words">
							<b>{schedule.name}</b> · {schedule.recurrence.kind === 'preset'
								? schedule.recurrence.preset
								: schedule.recurrence.cron} · {schedule.timezone}<br />
							Workflow:
							<a class="text-primary underline" href="#workflow-{schedule.workflow.workflow_id}"
								>{workflowName(schedule.workflow.workflow_id)}</a
							><br />
							Title: <span class="break-all">{schedule.title_template}</span><br />Description:
							<span class="break-all">{schedule.description_template}</span>
						</li>{/each}
					{#if !snapshot.document.schedules.length}<li class="text-muted-foreground">
							No schedules selected.
						</li>{/if}
				</ul>
				<h3 class="mt-4 text-sm font-semibold">Routing preferences</h3>
				<ul class="mt-1 space-y-1 text-sm">
					{#each snapshot.document.routing as route}<li class="break-words">
							<a class="text-primary underline" href="#state-{route.scope.state_id}"
								>{stateName(route.scope.state_id)}</a
							>
							· {route.tier}{route.scope.project ? ' · project-scoped' : ''}
						</li>{/each}
					{#if !snapshot.document.routing.length}<li class="text-muted-foreground">
							No routing preferences selected.
						</li>{/if}
				</ul>
			</article>
		</section>
		<footer
			class="text-muted-foreground flex flex-wrap items-center justify-between gap-3 border-t py-6 text-xs break-all"
		>
			<div class="min-w-0">
				<a class="underline" href="/public-workflow-policy" rel="noreferrer">Content rules</a
				><TechnicalDetails
					items={[
						{ label: 'Document fingerprint', value: snapshot.document_digest },
						{ label: 'File fingerprint', value: snapshot.bytes_sha256 }
					]}
				/>
			</div>
			<button
				class="min-h-10 rounded-md border px-3 text-sm"
				type="button"
				onclick={(event) => reportDialog?.show(event.currentTarget)}>Report this workflow</button
			>
		</footer>
	</main>
	{#if !data.user}<MarketingSignIn
			bind:this={signIn}
			returnTo={installReturn}
			errorReturnTo={signInErrorReturn}
			{linkError}
		/>{/if}
{:else}
	<main class="mx-auto flex min-h-screen max-w-xl items-center px-6">
		<div>
			<h1 class="text-2xl font-semibold">Publication unavailable</h1>
			<p class="text-muted-foreground mt-3">This publication is not available.</p>
		</div>
	</main>
{/if}
<PublicationReportDialog bind:this={reportDialog} snapshotId={snapshot.snapshot_id} />
