<script lang="ts">
	import type { TinesEvent } from '@tines/shared';
	import IconArrowRight from '@tabler/icons-svelte/icons/arrow-right';
	import IconBan from '@tabler/icons-svelte/icons/ban';
	import IconCirclePlus from '@tabler/icons-svelte/icons/circle-plus';
	import IconCopy from '@tabler/icons-svelte/icons/copy';
	import IconFolder from '@tabler/icons-svelte/icons/folder';
	import IconKey from '@tabler/icons-svelte/icons/key';
	import IconAlertTriangle from '@tabler/icons-svelte/icons/alert-triangle';
	import IconClockPause from '@tabler/icons-svelte/icons/clock-pause';
	import IconMessage from '@tabler/icons-svelte/icons/message';
	import IconPencil from '@tabler/icons-svelte/icons/pencil';
	import IconPlayerPlay from '@tabler/icons-svelte/icons/player-play';
	import IconPlayerSkipForward from '@tabler/icons-svelte/icons/player-skip-forward';
	import IconRepeat from '@tabler/icons-svelte/icons/repeat';
	import IconRobot from '@tabler/icons-svelte/icons/robot';
	import IconSitemap from '@tabler/icons-svelte/icons/sitemap';
	import IconTrash from '@tabler/icons-svelte/icons/trash';
	import { fade, slide } from 'svelte/transition';
	import StateBadge from '$lib/components/StateBadge.svelte';
	import { describeEvent, displayActor, prefersReducedMotion, relativeTime } from '$lib/format';

	let {
		events,
		showIssueLinks = true,
		showProject = true,
		emptyMessage = 'Nothing has happened yet.'
	}: {
		events: TinesEvent[];
		showIssueLinks?: boolean;
		showProject?: boolean;
		emptyMessage?: string;
	} = $props();

	const dur = () => (prefersReducedMotion() ? 0 : 200);

	function icon(ev: TinesEvent) {
		const type = ev.type;
		// The two link concepts keep their own icons everywhere they appear.
		if (isLinkEvent(ev)) return ev.payload.kind === 'duplicate_of' ? IconCopy : IconBan;
		if (type === 'issue.transitioned') return IconArrowRight;
		if (type === 'issue.commented') return IconMessage;
		if (type === 'scheduled_task.skipped') return IconPlayerSkipForward;
		if (type.startsWith('scheduled_task.')) return IconRepeat;
		if (type === 'issue.parked' || type === 'runner.errored') return IconAlertTriangle;
		if (type === 'runner.rate_limited') return IconClockPause;
		if (type === 'issue.resumed') return IconPlayerPlay;
		if (
			type.startsWith('runner.') ||
			type.startsWith('routing_rule.') ||
			type.startsWith('agent_run.') ||
			type === 'settings.updated'
		)
			return IconRobot;
		if (type.endsWith('.created')) return IconCirclePlus;
		if (type.endsWith('.deleted') || type.endsWith('.revoked')) return IconTrash;
		if (type.startsWith('project.')) return IconFolder;
		if (type.startsWith('workflow.')) return IconSitemap;
		if (type.startsWith('api_key.')) return IconKey;
		return IconPencil;
	}

	function isLinkEvent(ev: TinesEvent): boolean {
		return ev.type === 'issue.link_added' || ev.type === 'issue.link_removed';
	}
</script>

<!-- The issue the event row belongs to: a link on the global feed, "this
     issue" on an issue's own feed. -->
{#snippet selfRef(ev: TinesEvent)}
	{#if ev.issue_ref && showIssueLinks}
		<a
			href="/issues/{encodeURIComponent(ev.issue_ref.project_name)}/{ev.issue_ref.number}"
			class="font-medium hover:underline"
		>
			{showProject ? `${ev.issue_ref.project_name}/#${ev.issue_ref.number}` : `#${ev.issue_ref.number}`}
		</a>
	{:else}
		<span class="font-medium">this issue</span>
	{/if}
{/snippet}

{#if events.length === 0}
	<div class="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
		{emptyMessage}
	</div>
{:else}
	<ul class="space-y-1">
		{#each events as ev (ev.id)}
			{@const Icon = icon(ev)}
			<li
				class="flex items-start gap-3 rounded-md px-2 py-2.5 text-sm"
				in:slide={{ duration: dur() }}
				out:fade={{ duration: dur() }}
			>
				<span
					class="bg-muted text-muted-foreground mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full"
				>
					<Icon size={14} stroke={1.75} />
				</span>
				<div class="min-w-0 flex-1">
					<!-- Rows quote user text (issue titles, schedule and context names,
					     runner errors), so an unbroken token has to break here too. -->
					<p class="leading-snug wrap-anywhere">
						<!-- Svelte trims whitespace at block boundaries, so the space before
						     each segment has to be an explicit text node — and it has to sit
						     flush against the {#if} or the markup's own newline doubles it. -->
						<span class="font-medium">{displayActor(ev)}</span
						>{#each describeEvent(ev) as seg}{' '}{#if seg.kind === 'text'}
								<span class="text-muted-foreground">{seg.text}</span>
							{:else if seg.kind === 'self-ref'}
								{@render selfRef(ev)}
							{:else if seg.kind === 'other-ref'}
								<a
									href="/issues/{encodeURIComponent(seg.project_name)}/{seg.number}"
									class="font-medium hover:underline"
								>
									{seg.project_name}/#{seg.number}
								</a>
							{:else if seg.kind === 'name'}
								<span class="font-medium">“{seg.text}”</span>
							{:else if seg.kind === 'state-transition'}
								<span class="ml-1 inline-flex items-center gap-1.5 align-middle">
									<StateBadge
										state={{ name: seg.from, category: 'backlog' }}
										showDot={false}
										class="opacity-70"
									/>
									<IconArrowRight size={12} class="text-muted-foreground inline" />
									<StateBadge state={{ name: seg.to, category: 'active' }} showDot={false} />
								</span>
							{/if}
						{/each}
					</p>
				</div>
				<span
					class="text-muted-foreground shrink-0 text-xs"
					title={new Date(ev.created_at).toLocaleString()}
				>
					{relativeTime(ev.created_at)}
				</span>
			</li>
		{/each}
	</ul>
{/if}
