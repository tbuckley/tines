<!-- Project focus and project navigation, available at every project count. -->
<script lang="ts">
	import type { Project } from '@tines/shared';
	import IconCheck from '@tabler/icons-svelte/icons/check';
	import IconChevronDown from '@tabler/icons-svelte/icons/chevron-down';
	import { Popover } from 'bits-ui';
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
	let menu: HTMLDivElement;
	let activeMenuIndex: number | null = null;

	const label = $derived(focus?.name ?? 'All projects');
	const visibleLabel = $derived(projects.length >= 2 ? label : 'Projects');

	function focusOpenChoice(event: Event) {
		event.preventDefault();
		// Floating-position updates can remount Bits UI's focus scope while the
		// popover stays open. Its open-autofocus hook runs again on that remount,
		// so restore the current menu position instead of resetting to the checked
		// choice in the middle of a keyboard sequence.
		const items = menuItems();
		const target =
			(activeMenuIndex === null ? null : items[activeMenuIndex]) ??
			menu?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ??
			menu?.querySelector<HTMLElement>('[role="menuitem"]');
		if (!target) return;
		activeMenuIndex = items.indexOf(target);
		target.focus();
	}

	function menuItems(): HTMLElement[] {
		return menu
			? [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]')]
			: [];
	}

	function resetMenuPositionOnOpen(next: boolean) {
		if (next) activeMenuIndex = null;
	}

	function moveFocus(event: KeyboardEvent) {
		if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
		const items = menuItems();
		if (items.length === 0) return;
		event.preventDefault();
		const current = items.indexOf(document.activeElement as HTMLElement);
		const next =
			event.key === 'Home'
				? 0
				: event.key === 'End'
					? items.length - 1
					: event.key === 'ArrowDown'
						? (current + 1) % items.length
						: (current - 1 + items.length) % items.length;
		activeMenuIndex = next;
		items[next]?.focus();
	}

	async function choose(id: string | null) {
		open = false;
		error = null;
		try {
			await onchoose(id);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not change the project focus';
			activeMenuIndex = null;
			open = true;
		}
	}
</script>

<Popover.Root bind:open onOpenChange={resetMenuPositionOnOpen}>
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
				<span class="truncate">{visibleLabel}</span>
				<IconChevronDown size={14} stroke={2} class="shrink-0" />
			</button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Portal>
		<Popover.Content
			onOpenAutoFocus={focusOpenChoice}
			side="bottom"
			sideOffset={6}
			align="start"
			collisionPadding={8}
			class="bg-popover text-popover-foreground data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 ring-foreground/10 z-50 w-64 max-w-[calc(100vw-1rem)] rounded-lg p-1 shadow-md ring-1 outline-none"
		>
			<div
				bind:this={menu}
				role="menu"
				aria-label="Project focus"
				tabindex="-1"
				class="max-h-80 overflow-y-auto"
				onkeydown={moveFocus}
			>
				{#each projects.length > 0 ? [null, ...projects] : [] as project (project?.id ?? 'all')}
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
				{#if projects.length > 0}<div class="bg-border my-1 h-px"></div>{/if}
				{#if focus}
					<a
						href="/projects/{focus.id}"
						role="menuitem"
						class="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
						onclick={() => (open = false)}
					>
						<span class="w-4 shrink-0"></span> Open project
					</a>
				{/if}
				<a
					href={navMemory.projectsHref}
					role="menuitem"
					class="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
					onclick={() => (open = false)}
				>
					<span class="w-4 shrink-0"></span> Manage projects
				</a>
				<a
					href="/projects?new=1"
					role="menuitem"
					class="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
					onclick={() => (open = false)}
				>
					<span class="w-4 shrink-0"></span> New project
				</a>
				{#if error}
					<p class="text-destructive px-2 py-1.5 text-xs" role="alert">{error}</p>
				{/if}
			</div>
		</Popover.Content>
	</Popover.Portal>
</Popover.Root>
