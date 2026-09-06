<!--
	The project focus, in the app chrome (Tines/259). One control at every
	width: `Tines · <project> ▾` next to the wordmark, opening the list of
	projects plus All projects and Manage projects.

	Hidden below two projects — with one project there is nothing to switch
	between, and the empty state belongs to onboarding. It lives in the header
	on a phone too (human review, round 2): the phone header is otherwise
	wordmark and avatar with the width between them empty, while the bottom
	bar's Projects slot is a sixth of the screen and truncates the name to
	nothing. The bottom bar stays pure navigation.
-->
<script lang="ts">
	import type { Project } from '@tines/shared';
	import IconCheck from '@tabler/icons-svelte/icons/check';
	import IconChevronDown from '@tabler/icons-svelte/icons/chevron-down';
	import { Popover } from 'bits-ui';
	import { goto } from '$app/navigation';
	import { navMemory } from '$lib/nav-memory.svelte';

	let {
		projects,
		focus,
		onchoose
	}: {
		projects: Project[];
		focus: Project | null;
		/** Null means "All projects". */
		onchoose: (projectId: string | null) => Promise<void>;
	} = $props();

	let open = $state(false);
	let error = $state<string | null>(null);

	const label = $derived(focus?.name ?? 'All projects');

	async function choose(id: string | null) {
		open = false;
		error = null;
		try {
			await onchoose(id);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not change the project focus';
			open = true;
		}
	}
</script>

{#if projects.length >= 2}
	<Popover.Root bind:open>
		<Popover.Trigger>
			{#snippet child({ props })}
				<!--
					`min-w-0` so a long name truncates instead of pushing the
					account menu off a phone screen.
				-->
				<button
					{...props}
					type="button"
					class="text-muted-foreground hover:text-foreground -ml-1 flex h-8 max-w-[14rem] min-w-0 items-center gap-1 rounded-md px-1.5 text-sm font-medium transition-colors"
					aria-label="Project focus: {label}"
					aria-haspopup="menu"
				>
					<span aria-hidden="true">·</span>
					<span class="truncate">{label}</span>
					<IconChevronDown size={14} stroke={2} class="shrink-0" />
				</button>
			{/snippet}
		</Popover.Trigger>
		<Popover.Portal>
			<Popover.Content
				side="bottom"
				sideOffset={6}
				align="start"
				collisionPadding={8}
				class="bg-popover text-popover-foreground data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 ring-foreground/10 z-50 w-64 max-w-[calc(100vw-1rem)] rounded-lg p-1 shadow-md ring-1 outline-none"
			>
				<div role="menu" aria-label="Project focus" class="max-h-80 overflow-y-auto">
					{#each [null, ...projects] as project (project?.id ?? 'all')}
						{@const on = (focus?.id ?? null) === (project?.id ?? null)}
						<button
							type="button"
							role="menuitemradio"
							aria-checked={on}
							class="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
							onclick={() => choose(project?.id ?? null)}
						>
							<span class="w-4 shrink-0">
								{#if on}<IconCheck size={14} stroke={2} />{/if}
							</span>
							<span class="truncate {project ? '' : 'font-medium'}"
								>{project?.name ?? 'All projects'}</span
							>
						</button>
					{/each}
				</div>
				<div class="bg-border my-1 h-px"></div>
				<button
					type="button"
					role="menuitem"
					class="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
					onclick={() => {
						open = false;
						goto(navMemory.projectsHref);
					}}
				>
					<span class="w-4 shrink-0"></span> Manage projects
				</button>
				{#if error}
					<p class="text-destructive px-2 py-1.5 text-xs" role="alert">{error}</p>
				{/if}
			</Popover.Content>
		</Popover.Portal>
	</Popover.Root>
{/if}
