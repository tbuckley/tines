<script lang="ts">
	import IconDeviceDesktop from '@tabler/icons-svelte/icons/device-desktop';
	import IconMoon from '@tabler/icons-svelte/icons/moon';
	import IconSun from '@tabler/icons-svelte/icons/sun';
	import { Button } from '$lib/components/ui/button/index.js';
	import { theme, type ThemePreference } from '$lib/theme.svelte';

	const options: { value: ThemePreference; label: string; icon: typeof IconSun }[] = [
		{ value: 'system', label: 'System', icon: IconDeviceDesktop },
		{ value: 'light', label: 'Light', icon: IconSun },
		{ value: 'dark', label: 'Dark', icon: IconMoon }
	];
</script>

<svelte:head><title>Appearance · Tines</title></svelte:head>

<h1 class="mb-2 text-2xl font-semibold tracking-tight">Appearance</h1>
<p class="text-muted-foreground mb-6 max-w-2xl text-sm">
	Choose how Tines looks. <strong class="font-medium">System</strong> follows your device's appearance
	setting; picking Light or Dark overrides it. The choice is stored in this browser.
</p>

<div class="inline-flex gap-0.5 rounded-md border p-0.5" role="radiogroup" aria-label="Theme">
	{#each options as option (option.value)}
		{@const selected = theme.preference === option.value}
		<Button
			variant={selected ? 'default' : 'ghost'}
			size="sm"
			role="radio"
			aria-checked={selected}
			data-testid="theme-{option.value}"
			onclick={() => theme.set(option.value)}
		>
			<option.icon size={16} stroke={1.75} />
			{option.label}
		</Button>
	{/each}
</div>

{#if theme.preference === 'system'}
	<p class="text-muted-foreground mt-3 text-sm">
		Currently following your device: {theme.resolved}.
	</p>
{/if}
