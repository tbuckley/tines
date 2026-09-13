<script lang="ts">
	import { onMount } from 'svelte';
	import WorkflowGraph from '$lib/components/WorkflowGraph.svelte';
	import MarketingSignIn from '$lib/components/marketing/MarketingSignIn.svelte';
	import PublicTextSnippet from '$lib/components/publications/PublicTextSnippet.svelte';

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
	const installReturn = $derived(`/p/${snapshot.snapshot_id}?install=1`);

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
	><title>{main.name} — Public workflow</title><meta name="referrer" content="no-referrer" /><meta
		name="robots"
		content="noindex"
	/></svelte:head
>

{#if available}
	<main class="mx-auto min-h-screen max-w-5xl px-4 py-8 sm:px-6">
		<header class="border-b pb-6">
			<p class="text-muted-foreground text-sm">Public workflow snapshot</p>
			<h1 class="mt-1 text-3xl font-semibold wrap-break-word">{main.name}</h1>
			<p class="text-muted-foreground mt-2 text-sm">
				Published by {snapshot.metadata.display_name} · {snapshot.metadata.license} · immutable snapshot
			</p>
			<div class="mt-5 flex flex-wrap gap-3">
				{#if data.user}<a
						class="bg-primary text-primary-foreground rounded-md px-4 py-2 font-medium"
						href="/workflows/import?publication={snapshot.snapshot_id}"
						data-sveltekit-preload-data="off">Install a copy</a
					>{:else}<button
						class="bg-primary text-primary-foreground rounded-md px-4 py-2 font-medium"
						onclick={(event) => signIn?.open(event.currentTarget)}>Sign in to install</button
					>{/if}
				<button class="rounded-md border px-4 py-2 font-medium" type="button" onclick={download}
					>Download package</button
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
			{#each snapshot.document.workflows as workflow}<article class="mt-4 rounded-lg border p-4">
					<h3 class="font-semibold">
						{workflow.name}
						<span class="text-muted-foreground text-xs"
							>· {workflow.id === main.id ? 'main' : 'required dependency'}</span
						>
					</h3>
					<div class="mt-3 overflow-x-auto"><WorkflowGraph {workflow} /></div>
					<ul class="mt-4 space-y-2 text-sm">
						{#each workflow.transitions as transition}<li>
								<b>{transition.name}</b>{#if transition.requires.length}<ul class="list-disc pl-5">
										{#each transition.requires as gate}<li>
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
				{#each snapshot.document.context as item}<article
						class="min-w-0 rounded-lg border p-4"
						id="context-{item.id}"
					>
						<h3 class="font-semibold">
							{item.name} <span class="text-muted-foreground text-xs">· {item.kind}</span>
						</h3>
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
								<dd>{item.repo_branch ?? 'default'}</dd>
								<dt>Directory</dt>
								<dd>{item.repo_dir ?? 'root'}</dd>
							</dl>
							<p class="text-muted-foreground mt-2 text-xs">
								Declaration only. Repository contents are never fetched.
							</p>{/if}
					</article>{/each}
			</div>
		</section>
		<section class="grid gap-4 py-6 md:grid-cols-2">
			<article class="rounded-lg border p-4">
				<h2 class="font-semibold">Inputs</h2>
				<ul class="mt-2 space-y-2 text-sm">
					{#each snapshot.document.inputs as input}<li id="input-{input.id}">
							<code>{input.key}</code> · {input.type} · {input.required
								? 'required'
								: 'optional'}<br /><span class="text-muted-foreground"
								>Default: {input.default ?? 'none'}</span
							>
						</li>{/each}
				</ul>
			</article>
			<article class="rounded-lg border p-4">
				<h2 class="font-semibold">Selected automation</h2>
				<p class="mt-2 text-sm">
					{snapshot.document.schedules.length} schedules (installed paused) · {snapshot.document
						.routing.length} routing preferences
				</p>
			</article>
		</section>
		<footer class="text-muted-foreground border-t py-6 text-xs break-all">
			Document {snapshot.document_digest} · bytes {snapshot.bytes_sha256}
		</footer>
	</main>
	{#if !data.user}<MarketingSignIn
			bind:this={signIn}
			returnTo={installReturn}
			linkError={null}
		/>{/if}
{:else}
	<main class="mx-auto flex min-h-screen max-w-xl items-center px-6">
		<div>
			<h1 class="text-2xl font-semibold">Publication unavailable</h1>
			<p class="text-muted-foreground mt-3">This publication is not available.</p>
		</div>
	</main>
{/if}
