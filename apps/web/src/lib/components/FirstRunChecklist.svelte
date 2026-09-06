<script lang="ts">
	import IconCheck from '@tabler/icons-svelte/icons/check';
	import IconCircle from '@tabler/icons-svelte/icons/circle';
	import IconCircleDashed from '@tabler/icons-svelte/icons/circle-dashed';
	import IconCopy from '@tabler/icons-svelte/icons/copy';
	import { scale, slide } from 'svelte/transition';
	import RunRow from '$lib/components/RunRow.svelte';
	import PendingButton from '$lib/components/PendingButton.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import {
		checklistItems,
		checklistProgress,
		showRepoHint,
		type FirstRunInputs,
		type FirstRunItemId
	} from '$lib/first-run';
	import { prefersReducedMotion } from '$lib/format';
	import { isActiveRun } from '@tines/shared';

	/**
	 * The first-run checklist, shared by the Agents tab and an issue's agent
	 * activity card. Every tick is derived (`$lib/first-run`); the surfaces
	 * differ only in which handlers they pass — a missing handler renders that
	 * item's control as a link to the page that owns it, or as nothing when the
	 * item is already done.
	 */
	let {
		inputs,
		disabledReason = null,
		oncreateissue,
		onaddrunner,
		onroute,
		onenable,
		onadddescription,
		onaddrepo,
		onerror
	}: {
		inputs: FirstRunInputs;
		/** Archived project: the write controls disable with this as their tooltip. */
		disabledReason?: string | null;
		/** Agents tab: opens the New issue modal. Absent → the item links to /issues. */
		oncreateissue?: () => void;
		/** Agents tab: opens the Add runner wizard. Absent → the item links to /agents. */
		onaddrunner?: () => void;
		/** One-click "route everything here"; absent → the item links to the routing editor. */
		onroute?: () => Promise<void>;
		onenable: () => Promise<void>;
		/** Issue page only. */
		onadddescription?: () => void;
		/** Issue page only. */
		onaddrepo?: () => void;
		onerror: (e: unknown) => void;
	} = $props();

	const dur = () => (prefersReducedMotion() ? 0 : 180);
	const readOnly = $derived(disabledReason != null);

	const items = $derived(checklistItems(inputs));
	const progress = $derived(checklistProgress(items));
	const byId = $derived(
		Object.fromEntries(items.map((i) => [i.id, i])) as Record<
			FirstRunItemId,
			(typeof items)[number]
		>
	);

	/** One-click routing is only unambiguous while the account has one runner. */
	const soleRunner = $derived(inputs.runners.length === 1 ? inputs.runners[0] : null);

	const INSTALL_COMMAND = 'npm install -g tines';
	let commandCopied = $state(false);
	async function copyInstall() {
		try {
			await navigator.clipboard.writeText(INSTALL_COMMAND);
			commandCopied = true;
			setTimeout(() => (commandCopied = false), 2000);
		} catch {
			// Clipboard unavailable (permissions): the text stays selectable.
		}
	}

	let routing = $state(false);
	async function route() {
		if (!onroute || routing) return;
		routing = true;
		try {
			await onroute();
		} catch (e) {
			onerror(e);
		} finally {
			routing = false;
		}
	}

	let enabling = $state(false);
	async function enable() {
		if (enabling) return;
		enabling = true;
		try {
			await onenable();
		} catch (e) {
			onerror(e);
		} finally {
			enabling = false;
		}
	}
</script>

{#snippet mark(id: FirstRunItemId)}
	{@const item = byId[id]}
	<span class="mt-0.5 shrink-0" aria-hidden="true">
		{#if item.done}
			<span class="block text-emerald-600 dark:text-emerald-400" in:scale={{ duration: dur() }}>
				<IconCheck size={16} stroke={2} />
			</span>
		{:else if item.blocked}
			<span class="text-muted-foreground/40 block"><IconCircleDashed size={16} /></span>
		{:else}
			<span class="text-muted-foreground/60 block"><IconCircle size={16} /></span>
		{/if}
	</span>
{/snippet}

<section
	aria-label="First run checklist"
	class="mb-6 rounded-lg border p-4"
	data-testid="first-run-checklist"
>
	<div class="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
		<h2 class="text-sm font-semibold">Your first run</h2>
		<p class="text-muted-foreground text-xs" data-testid="first-run-progress">
			{progress.done} of {progress.total}
		</p>
	</div>

	<ol class="space-y-2.5 text-sm">
		<!-- 1. an issue to work on -->
		<li
			class="flex flex-wrap items-start gap-x-3 gap-y-1"
			data-item="issue"
			data-done={byId.issue.done}
		>
			{@render mark('issue')}
			<div class="min-w-0 flex-1">
				<p class:text-muted-foreground={byId.issue.done}>Have an issue for it</p>
				{#if !byId.issue.done}
					<p class="text-muted-foreground text-xs">Agents work issues — one is enough to start.</p>
				{/if}
			</div>
			{#if !byId.issue.done}
				{#if !inputs.hasAnyProject}
					<Button size="sm" variant="outline" href="/projects?new=1">Create a project</Button>
				{:else if oncreateissue}
					<Button
						size="sm"
						variant="outline"
						disabled={readOnly}
						title={disabledReason}
						onclick={oncreateissue}>Create an issue</Button
					>
				{:else}
					<Button size="sm" variant="outline" href="/issues">Create an issue</Button>
				{/if}
			{/if}
		</li>

		<!-- 2. the CLI, which the daemon ships in -->
		<li
			class="flex flex-wrap items-start gap-x-3 gap-y-1"
			data-item="cli"
			data-done={byId.cli.done}
		>
			{@render mark('cli')}
			<div class="min-w-0 flex-1">
				<p class:text-muted-foreground={byId.cli.done}>Install the CLI</p>
				{#if !byId.cli.done}
					<p class="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-2 text-xs">
						<code class="bg-muted rounded px-1.5 py-0.5">{INSTALL_COMMAND}</code>
						<Button size="sm" variant="ghost" class="h-6 px-1.5" onclick={copyInstall}>
							<IconCopy size={12} />
							{commandCopied ? 'Copied' : 'Copy'}
						</Button>
					</p>
				{/if}
			</div>
		</li>

		<!-- 3. a runner: the machine (or the cloud) that runs the agent -->
		<li
			class="flex flex-wrap items-start gap-x-3 gap-y-1"
			data-item="runner"
			data-done={byId.runner.done}
		>
			{@render mark('runner')}
			<div class="min-w-0 flex-1">
				<p class:text-muted-foreground={byId.runner.done}>Add a runner</p>
				{#if !byId.runner.done}
					<p class="text-muted-foreground text-xs">
						{#if inputs.runners.some((r) => r.status === 'paused')}
							Paused — resume it on the Agents tab.
						{:else if inputs.runners.length > 0}
							Registered, waiting for it to come online.
						{:else}
							This machine, or a Claude runner in the cloud.
						{/if}
					</p>
				{/if}
			</div>
			{#if !byId.runner.done}
				{#if onaddrunner}
					<Button size="sm" variant="outline" onclick={onaddrunner}>Add a runner</Button>
				{:else}
					<Button size="sm" variant="outline" href="/agents">Add a runner</Button>
				{/if}
			{/if}
		</li>

		<!-- 4. routing: which runner takes the work -->
		<li
			class="flex flex-wrap items-start gap-x-3 gap-y-1"
			data-item="rule"
			data-done={byId.rule.done}
		>
			{@render mark('rule')}
			<div class="min-w-0 flex-1">
				<p class:text-muted-foreground={byId.rule.done || byId.rule.blocked}>Route work to it</p>
				{#if !byId.rule.done}
					<p class="text-muted-foreground text-xs">
						{byId.rule.blocked
							? 'Add a runner first.'
							: 'Nothing dispatches until a rule names a runner.'}
					</p>
				{/if}
			</div>
			{#if !byId.rule.done && !byId.rule.blocked}
				{#if onroute && soleRunner}
					<PendingButton
						size="sm"
						variant="outline"
						pending={routing}
						disabled={readOnly}
						title={disabledReason}
						onclick={route}
					>
						Route everything to {soleRunner.name}
					</PendingButton>
				{:else}
					<Button size="sm" variant="outline" href="/agents#routing">Add a routing rule</Button>
				{/if}
			{/if}
		</li>

		<!-- 5. the kill switch, on -->
		<li
			class="flex flex-wrap items-start gap-x-3 gap-y-1"
			data-item="enabled"
			data-done={byId.enabled.done}
		>
			{@render mark('enabled')}
			<div class="min-w-0 flex-1">
				<p class:text-muted-foreground={byId.enabled.done}>Turn automation on</p>
				{#if !byId.enabled.done}
					<p class="text-muted-foreground text-xs">
						Nothing dispatches while it is off. You can turn it back off any time.
					</p>
				{/if}
			</div>
			{#if !byId.enabled.done}
				<PendingButton size="sm" pending={enabling} onclick={enable}
					>Turn automation on</PendingButton
				>
			{/if}
		</li>

		<!-- 6. something for the agent to read -->
		<li
			class="flex flex-wrap items-start gap-x-3 gap-y-1"
			data-item="content"
			data-done={byId.content.done}
		>
			{@render mark('content')}
			<div class="min-w-0 flex-1">
				<p class:text-muted-foreground={byId.content.done || byId.content.blocked}>
					Give the issue something to work with
				</p>
				{#if byId.content.blocked}
					<p class="text-muted-foreground text-xs">Create an issue first.</p>
				{:else if inputs.issue && !byId.content.done}
					<p class="text-muted-foreground text-xs">
						{#if inputs.surface === 'agents'}
							A description is what the agent is briefed with — add one to
							<a
								href="/issues/{encodeURIComponent(inputs.issue.project_name)}/{inputs.issue.number}"
								class="underline underline-offset-2">{inputs.issue.title}</a
							>.
						{:else}
							A description is what the agent is briefed with.
						{/if}
					</p>
				{/if}
				{#if showRepoHint(inputs) && onaddrepo}
					<p class="text-muted-foreground mt-1 text-xs">
						Optional: a repo gives the agent code to work in.
						<Button
							size="sm"
							variant="ghost"
							class="h-6 px-1.5"
							disabled={readOnly}
							title={disabledReason}
							onclick={onaddrepo}>Give the project a repo</Button
						>
					</p>
				{/if}
			</div>
			{#if !byId.content.done && !byId.content.blocked && onadddescription}
				<Button
					size="sm"
					variant="outline"
					disabled={readOnly}
					title={disabledReason}
					onclick={onadddescription}>Add a description</Button
				>
			{/if}
		</li>

		<!-- 7. the landing moment -->
		<li
			class="flex flex-wrap items-start gap-x-3 gap-y-1"
			data-item="run"
			data-done={byId.run.done}
		>
			{@render mark('run')}
			<div class="min-w-0 flex-1">
				{#if inputs.firstRun}
					<p class="font-medium">
						Your first run has {isActiveRun(inputs.firstRun.status) ? 'started' : 'run'} on
						{inputs.firstRun.runner_name}
					</p>
					<ul class="mt-2 divide-y rounded-lg border" in:slide={{ duration: dur() }}>
						<RunRow run={inputs.firstRun} showIssueRef={inputs.surface === 'agents'} />
					</ul>
				{:else if inputs.runElsewhere}
					<p>Your first run has started</p>
					<p class="text-muted-foreground text-xs">
						On another issue — <a href="/agents" class="underline underline-offset-2">watch it</a>.
					</p>
				{:else}
					<p class="text-muted-foreground">Your first run</p>
					<p class="text-muted-foreground text-xs">
						{byId.run.blocked
							? 'Appears here once the items above are done.'
							: 'Appears here as soon as one starts.'}
					</p>
				{/if}
			</div>
		</li>
	</ol>
</section>
