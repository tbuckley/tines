<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	let { data } = $props();
	$effect(() => {
		if (page.url.pathname !== data.canonicalPath)
			void goto(`${data.canonicalPath}${page.url.search}${page.url.hash}`, {
				replaceState: true,
				keepFocus: true,
				noScroll: true
			});
	});
</script>

<svelte:head><title>{data.issue.title} · Tines</title></svelte:head>
<main class="mx-auto max-w-4xl px-4 py-6">
	<a class="text-sm underline" href={`/projects/${data.issue.project.id}`}
		>← {data.issue.project.name}</a
	>
	<p class="text-muted-foreground mt-5 text-sm">
		#{data.issue.number} · {data.issue.state.name} · Shared by {data.issue.project.owner.name}
	</p>
	<h1 class="mt-2 text-2xl font-semibold">{data.issue.title}</h1>
	{#if data.issue.description}<div class="mt-5 whitespace-pre-wrap">
			{data.issue.description}
		</div>{/if}
	{#if data.issue.blocked_by_private_issue}<p class="mt-5" role="status">
			Blocked by another issue.
		</p>{/if}
	{#if data.issue.links.length > 0}
		<section class="mt-6" aria-labelledby="links-heading">
			<h2 id="links-heading" class="font-semibold">Linked issues</h2>
			<ul class="mt-2 space-y-2">
				{#each data.issue.links as link (link.id)}
					<li>
						{link.relation} ·
						<a
							class="underline"
							href={`/issues/${encodeURIComponent(link.project_id)}/${link.number}`}
							>{link.project_name}/#{link.number} · {link.title}</a
						>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
	<section class="mt-8" aria-labelledby="people-heading">
		<h2 id="people-heading" class="text-lg font-semibold">People and permission</h2>
		<ul class="mt-3 space-y-2">
			{#each data.issue.roster as person (person.user.id)}<li class="rounded border p-3">
					{person.user.name} · {person.role} · {person.value}
				</li>{/each}
		</ul>
		<p class="mt-2">Your agents cannot run on this project in this release.</p>
		<a class="mt-2 inline-block underline" href={`/projects/${data.issue.project.id}/people`}
			>View people</a
		>
	</section>
	<section class="mt-8" aria-labelledby="run-heading">
		<h2 id="run-heading" class="text-lg font-semibold">Latest run</h2>
		<p class="mt-2">{data.issue.latest_run?.status ?? 'No run yet'}</p>
	</section>
	<section class="mt-8" aria-labelledby="comments-heading">
		<h2 id="comments-heading" class="text-lg font-semibold">Comments</h2>
		{#if data.issue.comments.length === 0}<p class="mt-3">No comments yet.</p>{:else}<ul
				class="mt-3 space-y-4"
			>
				{#each data.issue.comments as comment (comment.id)}<li class="rounded-lg border p-4">
						<p class="text-sm font-medium">{comment.author.name}</p>
						<p class="mt-2 whitespace-pre-wrap">{comment.body}</p>
					</li>{/each}
			</ul>{/if}
	</section>
	<section class="mt-8" aria-labelledby="artifacts-heading">
		<h2 id="artifacts-heading" class="text-lg font-semibold">Artifacts</h2>
		{#if data.issue.artifacts.length === 0}<p class="mt-3">No artifacts yet.</p>{:else}<ul
				class="mt-3 space-y-2"
			>
				{#each data.issue.artifacts as artifact (artifact.id)}<li>
						<a
							class="underline"
							href={`/api/v1/issues/${data.issue.id}/artifacts/${encodeURIComponent(artifact.name)}/content`}
							>{artifact.name}</a
						>
					</li>{/each}
			</ul>{/if}
	</section>
	<section class="mt-8" aria-labelledby="history-heading">
		<h2 id="history-heading" class="text-lg font-semibold">History</h2>
		{#if data.issue.history.length === 0}<p class="mt-3">No shared history yet.</p>{:else}<ul
				class="mt-3 space-y-2"
			>
				{#each data.issue.history as event (event.id)}<li>
						{event.type} · {new Date(event.created_at).toLocaleString()}
					</li>{/each}
			</ul>{/if}
	</section>
</main>
