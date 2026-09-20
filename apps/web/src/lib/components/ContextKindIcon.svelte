<script lang="ts">
	import type { ContextKind } from '@tines/shared';
	import IconFileText from '@tabler/icons-svelte/icons/file-text';
	import IconGitBranch from '@tabler/icons-svelte/icons/git-branch';
	import IconPaperclip from '@tabler/icons-svelte/icons/paperclip';
	import IconKey from '@tabler/icons-svelte/icons/key';
	import IconTool from '@tabler/icons-svelte/icons/tool';

	let {
		kind,
		size = 16,
		stroke = 1.75
	}: { kind: ContextKind; size?: number; stroke?: number } = $props();

	const icons = {
		prompt: IconFileText,
		skill: IconTool,
		repo: IconGitBranch,
		artifact: IconPaperclip,
		env: IconKey
	} as const;
	const Icon = $derived(icons[kind] ?? IconFileText);
</script>

<Icon {size} {stroke} />
