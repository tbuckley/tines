<script lang="ts">
	import type { TinesEvent } from '@tines/shared';
	import IconArrowRight from '@tabler/icons-svelte/icons/arrow-right';
	import IconBan from '@tabler/icons-svelte/icons/ban';
	import IconCirclePlus from '@tabler/icons-svelte/icons/circle-plus';
	import IconCopy from '@tabler/icons-svelte/icons/copy';
	import IconFolder from '@tabler/icons-svelte/icons/folder';
	import IconKey from '@tabler/icons-svelte/icons/key';
	import IconAlertTriangle from '@tabler/icons-svelte/icons/alert-triangle';
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
	import { actorLabel, prefersReducedMotion, relativeTime } from '$lib/format';

	let {
		events,
		showIssueLinks = true,
		emptyMessage = 'Nothing has happened yet.'
	}: { events: TinesEvent[]; showIssueLinks?: boolean; emptyMessage?: string } = $props();

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

	function verb(ev: TinesEvent): string {
		const p = ev.payload;
		switch (ev.type) {
			case 'issue.created':
				return 'created';
			case 'issue.updated':
				return `updated ${(p.changed as string[])?.join(' and ') ?? ''} of`;
			case 'issue.transitioned':
				return 'moved';
			case 'issue.commented':
				return 'commented on';
			case 'project.created':
				return 'created project';
			case 'project.updated':
				return 'updated project';
			case 'project.deleted':
				return 'deleted project';
			case 'workflow.created':
				return 'created workflow';
			case 'workflow.updated':
				return 'updated workflow';
			case 'workflow.deleted':
				return 'deleted workflow';
			case 'api_key.created':
				return 'created API key';
			case 'api_key.revoked':
				return 'revoked API key';
			case 'scheduled_task.created':
				return 'created schedule';
			case 'scheduled_task.updated':
				return 'updated schedule';
			case 'scheduled_task.deleted':
				return 'deleted schedule';
			case 'scheduled_task.skipped':
				return 'skipped an occurrence of schedule';
			case 'runner.registered':
				return 'registered runner';
			case 'runner.updated':
				return 'updated runner';
			case 'runner.removed':
				return 'removed runner';
			case 'runner.errored':
				return `saw runner “${p.runner_name}” fail to launch (${p.consecutive_failures} consecutive): ${p.error}`;
			case 'agent_run.started':
				return `started a ${p.tier} run via “${p.runner_name}” on`;
			case 'agent_run.ended':
				return `run ${String(p.status).replaceAll('_', ' ')}${p.outcome ? ` — ${p.outcome}` : ''} via “${p.runner_name}” on`;
			case 'issue.parked':
				return `parked`;
			case 'issue.resumed':
				return 'resumed';
			case 'routing_rule.created':
				return `created the ${p.scope_label} routing rule`;
			case 'routing_rule.updated':
				return `updated the ${p.scope_label} routing rule`;
			case 'routing_rule.deleted':
				return `deleted the ${p.scope_label} routing rule`;
			case 'settings.updated':
				return `updated supervisor settings (${(p.changed as string[])?.join(', ') || 'no changes'})`;
			case 'context.created':
			case 'context.updated':
			case 'context.deleted': {
				const action = ev.type.split('.')[1];
				// With an issue link following, name the item here; otherwise
				// objectName() renders the payload name after the verb.
				return ev.issue_ref
					? `${action} ${p.kind} “${p.name}” on`
					: `${action} ${p.kind}`;
			}
			default:
				return ev.type;
		}
	}

	/**
	 * Sweep-created issues carry the schedule in the payload and no API key:
	 * shown as "Alice via schedule “Daily triage”", parallel to API-key
	 * attribution. Run-now instances (`manual: true`) keep the normal actor.
	 */
	function displayActor(ev: TinesEvent): string {
		if (ev.type === 'issue.created' && ev.payload.scheduled_task_name && !ev.payload.manual) {
			return `${ev.actor.user_name} via schedule “${ev.payload.scheduled_task_name}”`;
		}
		return actorLabel(ev.actor);
	}

	function isLinkEvent(ev: TinesEvent): boolean {
		return ev.type === 'issue.link_added' || ev.type === 'issue.link_removed';
	}

	/**
	 * Link events read as sentences from the owning issue's perspective:
	 * "marked this as blocking demo/14". The only shape that puts the other
	 * issue first is "marked web/9 as a duplicate of this" (role `target`).
	 */
	function linkPhrasing(ev: TinesEvent): { lead: string; middle: string; otherFirst: boolean } {
		const lead = ev.type === 'issue.link_added' ? 'marked' : 'unmarked';
		if (ev.payload.kind === 'duplicate_of') {
			return { lead, middle: 'as a duplicate of', otherFirst: ev.payload.role === 'target' };
		}
		return {
			lead,
			middle: ev.payload.role === 'target' ? 'as blocked by' : 'as blocking',
			otherFirst: false
		};
	}

	/** Display object of the event: an issue link, or a payload name. */
	function objectName(ev: TinesEvent): string | null {
		if (ev.issue_ref) return null; // rendered as a link instead
		const name = ev.payload.name;
		return typeof name === 'string' ? name : null;
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
			{ev.issue_ref.project_name}/#{ev.issue_ref.number}
		</a>
	{:else}
		<span class="font-medium">this issue</span>
	{/if}
{/snippet}

{#snippet otherRef(ev: TinesEvent)}
	<a
		href="/issues/{encodeURIComponent(String(ev.payload.other_project_name))}/{ev.payload.other_number}"
		class="font-medium hover:underline"
	>
		{ev.payload.other_project_name}/#{ev.payload.other_number}
	</a>
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
				<span class="bg-muted text-muted-foreground mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full">
					<Icon size={14} stroke={1.75} />
				</span>
				<div class="min-w-0 flex-1">
					<p class="leading-snug">
						<span class="font-medium">{displayActor(ev)}</span>
						{#if isLinkEvent(ev)}
							{@const phrasing = linkPhrasing(ev)}
							<span class="text-muted-foreground"> {phrasing.lead} </span>
							{#if phrasing.otherFirst}
								{@render otherRef(ev)}
								<span class="text-muted-foreground"> {phrasing.middle} </span>
								{@render selfRef(ev)}
							{:else}
								{@render selfRef(ev)}
								<span class="text-muted-foreground"> {phrasing.middle} </span>
								{@render otherRef(ev)}
								{#if ev.payload.other_title}
									<span class="text-muted-foreground">— {ev.payload.other_title}</span>
								{/if}
							{/if}
						{:else}
							<span class="text-muted-foreground"> {verb(ev)} </span>
							{#if ev.issue_ref}
								{#if showIssueLinks}
									<a
										href="/issues/{encodeURIComponent(ev.issue_ref.project_name)}/{ev.issue_ref.number}"
										class="font-medium hover:underline"
									>
										{ev.issue_ref.project_name}/#{ev.issue_ref.number}
									</a>
								{:else}
									<span class="font-medium">this issue</span>
								{/if}
								{#if ev.type === 'issue.created'}
									<span class="text-muted-foreground">— {ev.payload.title}</span>
								{/if}
								{#if ev.type === 'issue.updated' && ev.payload.workflow_to_name}
									<span class="text-muted-foreground">
										from “{ev.payload.workflow_from_name}” to “{ev.payload.workflow_to_name}”
									</span>
								{/if}
								{#if ev.type === 'issue.parked'}
									<span class="text-muted-foreground">
										after {ev.payload.attempt_count} strikes — needs attention
									</span>
								{/if}
							{:else if objectName(ev)}
								<span class="font-medium">“{objectName(ev)}”</span>
							{/if}
							{#if ev.type === 'issue.transitioned'}
								{#if ev.payload.action}
									<span class="text-muted-foreground">via</span>
									<span class="font-medium">“{ev.payload.action}”</span>
								{:else if ev.payload.forced}
									<span class="text-muted-foreground">directly</span>
								{/if}
								<span class="ml-1 inline-flex items-center gap-1.5 align-middle">
									<StateBadge
										state={{ name: String(ev.payload.from_state_name ?? '?'), category: 'backlog' }}
										showDot={false}
										class="opacity-70"
									/>
									<IconArrowRight size={12} class="text-muted-foreground inline" />
									<StateBadge
										state={{ name: String(ev.payload.to_state_name ?? '?'), category: 'active' }}
										showDot={false}
									/>
								</span>
							{/if}
						{/if}
					</p>
				</div>
				<span class="text-muted-foreground shrink-0 text-xs" title={new Date(ev.created_at).toLocaleString()}>
					{relativeTime(ev.created_at)}
				</span>
			</li>
		{/each}
	</ul>
{/if}
