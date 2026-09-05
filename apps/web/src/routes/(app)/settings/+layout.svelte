<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';

	let { children }: { children: Snippet } = $props();

	// The same four pages, in the same order, as the avatar menu in
	// (app)/+layout.svelte — keep the two lists in step.
	const tabs = [
		{ href: '/settings/appearance', label: 'Appearance' },
		{ href: '/settings/labels', label: 'Labels' },
		{ href: '/settings/api-keys', label: 'API keys' },
		{ href: '/settings/export-import', label: 'Export / import' }
	];
</script>

<!-- Named so a settings-to-settings hop crossfades the page body under a header that stays put. -->
<div class="mb-6" style:view-transition-name="settings-nav">
	<p class="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">Settings</p>
	<nav aria-label="Settings">
		<!--
			Mirrors the category pill in IssueFilterBar.svelte, minus its fixed height:
			`inline-flex` so the pill hugs its tabs rather than stretching across the
			column, `flex-wrap` and no `h-9` so four text-only tabs (348px) fold to a
			second row below ~390px instead of overflowing. Icons here would make it
			436px, which does not fit a phone — they stay in the avatar menu.
		-->
		<div class="bg-muted/60 inline-flex flex-wrap items-center gap-0.5 rounded-md border p-[3px]">
			{#each tabs as tab (tab.href)}
				{@const on = page.url.pathname.startsWith(tab.href)}
				<a
					href={tab.href}
					data-sveltekit-keepfocus
					aria-current={on ? 'page' : undefined}
					class="flex h-7 items-center rounded-[5px] px-2.5 text-[13px] whitespace-nowrap transition-colors {on
						? 'bg-background text-foreground font-medium shadow-xs'
						: 'text-muted-foreground hover:text-foreground'}"
				>
					{tab.label}
				</a>
			{/each}
		</div>
	</nav>
</div>

{@render children()}
