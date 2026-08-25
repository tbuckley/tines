<script lang="ts">
	import type { TinesEvent } from '@tines/shared';
	import IconArrowRight from '@tabler/icons-svelte/icons/arrow-right';
	import IconCirclePlus from '@tabler/icons-svelte/icons/circle-plus';
	import IconFolder from '@tabler/icons-svelte/icons/folder';
	import IconKey from '@tabler/icons-svelte/icons/key';
	import IconMessage from '@tabler/icons-svelte/icons/message';
	import IconPencil from '@tabler/icons-svelte/icons/pencil';
	import IconPlayerSkipForward from '@tabler/icons-svelte/icons/player-skip-forward';
	import IconRepeat from '@tabler/icons-svelte/icons/repeat';
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

	function icon(type: string) {
		if (type === 'issue.transitioned') return IconArrowRight;
		if (type === 'issue.commented') return IconMessage;
		if (type === 'scheduled_task.skipped') return IconPlayerSkipForward;
		if (type.startsWith('scheduled_task.')) return IconRepeat;
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

	/** Display object of the event: an issue link, or a payload name. */
	function objectName(ev: TinesEvent): string | null {
		if (ev.issue_ref) return null; // rendered as a link instead
		const name = ev.payload.name;
		return typeof name === 'string' ? name : null;
	}
</script>

{#if events.length === 0}
	<div class="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
		{emptyMessage}
	</div>
{:else}
	<ul class="space-y-1">
		{#each events as ev (ev.id)}
			{@const Icon = icon(ev.type)}
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
					</p>
				</div>
				<span class="text-muted-foreground shrink-0 text-xs" title={new Date(ev.created_at).toLocaleString()}>
					{relativeTime(ev.created_at)}
				</span>
			</li>
		{/each}
	</ul>
{/if}
