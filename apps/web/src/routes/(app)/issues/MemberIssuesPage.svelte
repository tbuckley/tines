<script lang="ts">
	let { data } = $props();
</script>

<svelte:head><title>Issues · {data.project.name} · Tines</title></svelte:head>
<main class="mx-auto max-w-4xl px-4 py-6">
	<a class="text-sm underline" href={`/projects/${data.project.id}`}>← {data.project.name}</a>
	<h1 class="mt-5 text-2xl font-semibold">Issues</h1>
	<form class="mt-5 flex flex-wrap gap-2" method="GET" action="/issues">
		<label>Search <input class="rounded border p-2" name="q" value={data.filters.q} /></label>
		<label
			>Category <select class="rounded border p-2" name="category" value={data.filters.category}
				><option value="">All</option><option value="backlog">Backlog</option><option value="active"
					>Active</option
				><option value="awaiting_human">Awaiting</option><option value="done">Done</option></select
			></label
		>
		<button class="rounded border px-4 py-2">Filter</button>
	</form>
	{#if data.issues.length === 0}<p class="mt-6">No issues match this view.</p>{:else}
		<ul class="mt-6 space-y-2">
			{#each data.issues as issue (issue.id)}<li>
					<a
						class="hover:bg-muted block rounded border p-4"
						href={`/issues/${data.project.id}/${issue.number}`}
						><span class="text-muted-foreground text-sm">#{issue.number} · {issue.state.name}</span
						><span class="mt-1 block font-medium">{issue.title}</span></a
					>
				</li>{/each}
		</ul>
	{/if}
</main>
