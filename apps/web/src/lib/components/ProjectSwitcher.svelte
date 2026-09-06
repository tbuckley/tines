<!--
	The project focus, in the app chrome (Tines/259). One control in two
	dresses: the desktop header's `Tines · <project> ▾` and the mobile bottom
	bar's Projects slot, which opens the same list upward as a sheet.

	Hidden below two projects — with one project there is nothing to switch
	between, and the empty state belongs to onboarding.
-->
<script lang="ts">
	import type { Project } from '@tines/shared';
	import IconCheck from '@tabler/icons-svelte/icons/check';
	import IconChevronDown from '@tabler/icons-svelte/icons/chevron-down';
	import IconFolder from '@tabler/icons-svelte/icons/folder';
	import { Popover } from 'bits-ui';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { truncate } from '$lib/format';
	import { navMemory } from '$lib/nav-memory.svelte';

	let {
		projects,
		focus,
		variant = 'header',
		onchoose
	}: {
		projects: Project[];
		focus: Project | null;
		variant?: 'header' | 'tab';
		/** Null means "All projects". */
		onchoose: (projectId: string | null) => Promise<void>;
	} = $props();

	let open = $state(false);
	let error = $state<string | null>(null);

	const label = $derived(focus?.name ?? 'All projects');
	const onProjects = $derived(page.url.pathname.startsWith('/projects'));

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
				{#if variant === 'header'}
					<button
						{...props}
						type="button"
						class="text-muted-foreground hover:text-foreground -ml-1 flex h-8 max-w-[14rem] items-center gap-1 rounded-md px-1.5 text-sm font-medium transition-colors"
						aria-label="Project focus: {label}"
						aria-haspopup="menu"
					>
						<span aria-hidden="true">·</span>
						<span class="truncate">{label}</span>
						<IconChevronDown size={14} stroke={2} />
					</button>
				{:else}
					<button
						{...props}
						type="button"
						class="flex flex-col items-center justify-center gap-1 text-[0.6875rem] font-medium transition active:scale-90 {onProjects
							? 'text-foreground'
							: 'text-muted-foreground'}"
						aria-label="Project focus: {label}"
						aria-haspopup="menu"
						aria-current={onProjects ? 'page' : undefined}
					>
						<IconFolder size={20} stroke={onProjects ? 2 : 1.5} />
						<span class="max-w-full truncate px-1"
							>{focus ? truncate(focus.name, 12) : 'Projects'}</span
						>
					</button>
				{/if}
			{/snippet}
		</Popover.Trigger>
		<Popover.Portal>
			<Popover.Content
				side={variant === 'tab' ? 'top' : 'bottom'}
				sideOffset={variant === 'tab' ? 8 : 6}
				align="start"
				collisionPadding={8}
				class="bg-popover text-popover-foreground data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 ring-foreground/10 z-50 rounded-lg p-1 shadow-md ring-1 outline-none {variant ===
				'tab'
					? 'w-[calc(100vw-1rem)]'
					: 'w-64'}"
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
