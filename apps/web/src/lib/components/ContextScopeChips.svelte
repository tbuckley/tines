<script lang="ts">
	import type { ContextScope } from '@tines/shared';
	import LabelChip from './LabelChip.svelte';
	import IconFolder from '@tabler/icons-svelte/icons/folder';
	import IconListDetails from '@tabler/icons-svelte/icons/list-details';
	import IconSitemap from '@tabler/icons-svelte/icons/sitemap';
	import IconWorld from '@tabler/icons-svelte/icons/world';

	/**
	 * Compact chips for a scope, in the canonical project · state · label ·
	 * issue order. `link` renders project/issue/label chips as links to their
	 * pages.
	 *
	 * The state chip reads `{workflow} / {state}` — the form the item
	 * editor's "Only in state" select uses — because a state name alone
	 * ("Backlog", "Review") repeats across every workflow. `short` drops the
	 * workflow for callers that already group by it.
	 */
	let {
		scope,
		link = false,
		short = false
	}: { scope: ContextScope; link?: boolean; short?: boolean } = $props();

	/**
	 * The chip is the flex box and owns the width cap; the text inside it is a
	 * separate block child wearing `truncate` (see `textClass`). `text-overflow`
	 * only applies to a block container's own inline text, so a `truncate` on
	 * the `inline-flex` chip itself clipped mid-glyph with no ellipsis
	 * (Tines/221) — it kept the `overflow: hidden` half and silently dropped
	 * the ellipsis half.
	 *
	 * The cap is responsive because a chip does not always share its row with
	 * something that can wrap: `ContextItemList` puts the item's own name and
	 * the chips on one non-wrapping flex row, and the chips wrapper never
	 * shrinks below this cap, so every pixel of it comes out of the name. At
	 * 224px the name was down to a glyph or two on a phone, so narrow viewports
	 * keep the old 192px and only `sm` and up get the wider cap.
	 */
	const chipClass =
		'bg-muted text-muted-foreground inline-flex max-w-48 items-center gap-1 overflow-hidden rounded-full px-2 py-0.5 text-xs sm:max-w-56';
	/**
	 * The truncating text child. `overflow-hidden` on the chip and `shrink-0` on
	 * the icons are belt-and-braces today — the chip never shrinks below its cap,
	 * so this child's own `overflow: hidden` does all the clipping — and become
	 * load-bearing only if the chip is ever made shrinkable.
	 */
	const textClass = 'truncate';
</script>

<span class="inline-flex flex-wrap items-center gap-1">
	{#if !scope.project_id && !scope.workflow_state_id && !scope.label_id && !scope.issue_id}
		<span class={chipClass} title="Global — applies to every launch prompt">
			<IconWorld size={12} stroke={1.75} class="shrink-0" />
			<span class={textClass}>global</span>
		</span>
	{/if}
	{#if scope.project_id}
		{#if link}
			<a
				href="/projects/{scope.project_id}"
				class="{chipClass} hover:text-foreground"
				title="project {scope.project_name}"
			>
				<IconFolder size={12} stroke={1.75} class="shrink-0" />
				<span class={textClass}>{scope.project_name}</span>
			</a>
		{:else}
			<span class={chipClass} title="project {scope.project_name}">
				<IconFolder size={12} stroke={1.75} class="shrink-0" />
				<span class={textClass}>{scope.project_name}</span>
			</span>
		{/if}
	{/if}
	{#if scope.workflow_state_id}
		<span
			class={chipClass}
			title="state {scope.workflow_state_name} (workflow “{scope.workflow_name}”)"
		>
			<IconSitemap size={12} stroke={1.75} class="shrink-0" />
			<span class={textClass}
				>{short || !scope.workflow_name
					? scope.workflow_state_name
					: `${scope.workflow_name} / ${scope.workflow_state_name}`}</span
			>
		</span>
	{/if}
	{#if scope.label_id && scope.label_name}
		<!-- The issue label keeps its own colour here rather than wearing the
		     grey `chipClass`: it is the same object the issue rows show, and a
		     reader matches it by colour before they read it. -->
		{#if link}
			<a href="/context?label={scope.label_id}" title="label {scope.label_name}">
				<LabelChip
					label={{ name: scope.label_name, color: scope.label_color ?? 'slate' }}
					size="sm"
					variant="dot"
				/>
			</a>
		{:else}
			<span title="label {scope.label_name}">
				<LabelChip
					label={{ name: scope.label_name, color: scope.label_color ?? 'slate' }}
					size="sm"
					variant="dot"
				/>
			</span>
		{/if}
	{/if}
	{#if scope.issue_id && scope.issue_ref}
		{#if link}
			<a
				href="/issues/{encodeURIComponent(scope.issue_ref.project_name)}/{scope.issue_ref.number}"
				class="{chipClass} hover:text-foreground"
				title="issue {scope.issue_ref.project_name}/{scope.issue_ref.number}"
			>
				<IconListDetails size={12} stroke={1.75} class="shrink-0" />
				<span class={textClass}>{scope.issue_ref.project_name}/{scope.issue_ref.number}</span>
			</a>
		{:else}
			<span class={chipClass} title="issue {scope.issue_ref.project_name}/{scope.issue_ref.number}">
				<IconListDetails size={12} stroke={1.75} class="shrink-0" />
				<span class={textClass}>{scope.issue_ref.project_name}/{scope.issue_ref.number}</span>
			</span>
		{/if}
	{/if}
</span>
