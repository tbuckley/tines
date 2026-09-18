<script lang="ts">
	import { onMount, tick } from 'svelte';
	import type { TextUseField } from '@tines/shared';
	import { page } from '$app/state';
	import WorkflowGraph from '$lib/components/WorkflowGraph.svelte';
	import MarketingSignIn from '$lib/components/marketing/MarketingSignIn.svelte';
	import PublicTextSnippet from '$lib/components/publications/PublicTextSnippet.svelte';
	import PublicationReportDialog from '$lib/components/publications/PublicationReportDialog.svelte';
	import TechnicalDetails from '$lib/components/publications/TechnicalDetails.svelte';
	import {
		inspectorTargetId,
		publicInstructionLayers,
		type InspectorTarget
	} from '$lib/publications/inspector';

	let { data } = $props();
	const snapshot = $derived(data.snapshot);
	const main = $derived(
		snapshot.document.workflows.find(
			(workflow) => workflow.id === snapshot.document.main_workflow_id
		)!
	);
	let available = $state(true);
	let checking = $state(false);
	let signIn = $state<MarketingSignIn>();
	let reportDialog = $state<PublicationReportDialog>();
	let expandedFields = $state<Record<string, boolean>>({});
	let navigation = $state<Array<{ triggerId: string; fallbackId: string; x: number; y: number }>>(
		[]
	);
	const installReturn = $derived(`/p/${snapshot.snapshot_id}/install`);
	const signInErrorReturn = $derived(`/p/${snapshot.snapshot_id}?install=1&error=signin`);
	const linkError = $derived(
		page.url.searchParams.has('error')
			? 'That sign-in link is invalid or has expired. Enter your email to get a new one.'
			: null
	);
	const visible = $derived(available && !checking);

	function stateName(id: string) {
		return (
			snapshot.document.workflows
				.flatMap((workflow) => workflow.states)
				.find((state) => state.id === id)?.name ?? id
		);
	}

	function workflowName(id: string) {
		return snapshot.document.workflows.find((workflow) => workflow.id === id)?.name ?? id;
	}

	function inputUses(id: string) {
		return snapshot.document.text_uses.filter((use) => use.input_id === id);
	}
	function fieldUses(recordId: string, field: TextUseField) {
		return snapshot.document.text_uses
			.filter((use) => use.target.record_id === recordId && use.target.field === field)
			.map(({ id, input_id, token }) => ({ id, input_id, token }));
	}
	function targetId(target: InspectorTarget) {
		return inspectorTargetId(target);
	}
	function fieldId(recordId: string, field: TextUseField) {
		return targetId({ kind: 'field', recordId, field });
	}
	function fieldFormat(recordId: string): 'markdown' | 'text' {
		const file = snapshot.document.context
			.flatMap((item) => (item.kind === 'skill' ? item.files : []))
			.find((item) => item.id === recordId);
		return file?.path.toLowerCase().endsWith('.txt') ? 'text' : 'markdown';
	}

	async function navigateTo(target: InspectorTarget, trigger: HTMLElement, fallbackId?: string) {
		if (!trigger.id) trigger.id = `public-trigger-${crypto.randomUUID()}`;
		const id = targetId(target);
		if (target.kind === 'field') expandedFields[id] = true;
		navigation.push({
			triggerId: trigger.id,
			fallbackId: fallbackId ?? trigger.closest('[id]')?.id ?? trigger.id,
			x: scrollX,
			y: scrollY
		});
		await tick();
		const element = document.getElementById(id);
		element?.focus({ preventScroll: true });
		element?.scrollIntoView({
			block: 'center',
			behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
		});
	}

	async function backToSource() {
		const previous = navigation.pop();
		if (!previous) return;
		await tick();
		const element =
			document.getElementById(previous.triggerId) ?? document.getElementById(previous.fallbackId);
		if (element) {
			element.focus({ preventScroll: true });
			element.scrollIntoView({ block: 'center' });
		} else scrollTo(previous.x, previous.y);
	}

	function clearReaderState() {
		navigation = [];
		expandedFields = {};
		available = false;
	}

	async function recheck() {
		if (checking || !available) return available;
		const active = document.activeElement;
		const restoreFocusId =
			active instanceof HTMLElement && active.closest('[data-public-reader]') ? active.id : '';
		checking = true;
		try {
			const response = await fetch(`/api/v1/publications/public/${snapshot.snapshot_id}/status`, {
				cache: 'no-store'
			});
			if (!response.ok) clearReaderState();
			else {
				const status = await response.json();
				if (status.status_version !== snapshot.status_version) clearReaderState();
			}
		} catch {
			clearReaderState();
		} finally {
			checking = false;
			if (available && restoreFocusId) {
				await tick();
				document.getElementById(restoreFocusId)?.focus({ preventScroll: true });
			}
		}
		return available;
	}

	async function download() {
		if (await recheck())
			location.href = `/api/v1/publications/public/${snapshot.snapshot_id}/download`;
	}

	onMount(() => {
		const resumed = () => void recheck();
		const escape = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && navigation.length && !document.querySelector('[role="dialog"]'))
				void backToSource();
		};
		const timer = setInterval(() => {
			if (!document.hidden) void recheck();
		}, 15_000);
		addEventListener('focus', resumed);
		addEventListener('pageshow', resumed);
		addEventListener('keydown', escape);
		return () => {
			clearInterval(timer);
			removeEventListener('focus', resumed);
			removeEventListener('pageshow', resumed);
			removeEventListener('keydown', escape);
		};
	});
</script>

<svelte:head
	><title>{visible ? `${main.name} — Public workflow` : 'Publication unavailable'}</title><meta
		name="referrer"
		content="no-referrer"
	/><meta name="robots" content="noindex" /></svelte:head
>

{#if visible}
	<main
		class="mx-auto min-h-screen max-w-5xl min-w-0 overflow-x-hidden px-4 py-8 sm:px-6"
		data-public-reader
	>
		<header class="border-b pb-6">
			<button
				type="button"
				class="text-primary mb-3 min-h-10 underline"
				hidden={!navigation.length}
				disabled={!navigation.length}
				onclick={backToSource}>Back to source</button
			>
			<p class="text-muted-foreground text-sm">Shared workflow</p>
			<h1 class="mt-1 text-3xl font-semibold wrap-break-word">{main.name}</h1>
			<p class="text-muted-foreground mt-2 min-w-0 text-sm break-words">
				Published by {snapshot.metadata.display_name} · {snapshot.metadata.license} · this shared version
				will not change
			</p>
			<div class="mt-5 flex flex-wrap gap-3">
				<button
					class="focus-visible:ring-ring/50 rounded-md border px-4 py-2 font-medium outline-none focus-visible:ring-[3px]"
					type="button"
					onclick={(event) => reportDialog?.show(event.currentTarget)}>Report</button
				>
				{#if data.user}<a
						class="bg-primary text-primary-foreground rounded-md px-4 py-2 font-medium"
						href="/workflows/import?publication={snapshot.snapshot_id}"
						data-sveltekit-preload-data="off">Install a copy</a
					>{/if}
				{#if !data.user}<button
						class="bg-primary text-primary-foreground rounded-md px-4 py-2 font-medium"
						onclick={(event) => signIn?.open(event.currentTarget)}>Sign in to install</button
					>{/if}
				<button class="rounded-md border px-4 py-2 font-medium" type="button" onclick={download}
					>Download file</button
				>
				<a
					class="rounded-md border px-4 py-2 font-medium"
					href="/api/v1/publications/public/{snapshot.snapshot_id}/reuse.txt"
					rel="noreferrer"
					data-sveltekit-reload>Reuse notice</a
				>
			</div>
		</header>

		<section class="py-6" aria-labelledby="summary">
			<h2 id="summary" class="text-xl font-semibold">What this workflow does</h2>
			<div class="mt-3">
				<PublicTextSnippet
					source={main.description || 'No description provided.'}
					uses={fieldUses(main.id, 'description')}
					fieldId={fieldId(main.id, 'description')}
					bind:expanded={expandedFields[fieldId(main.id, 'description')]}
					onToken={(inputId, _useId, trigger) =>
						navigateTo({ kind: 'input', inputId }, trigger, fieldId(main.id, 'description'))}
				/>
			</div>
		</section>
		<section class="py-6" aria-labelledby="graph">
			<h2 id="graph" class="text-xl font-semibold">Workflow graph and gates</h2>
			<nav class="mt-3" aria-label="Bundled workflow dependencies">
				<ul class="flex min-w-0 flex-wrap gap-2 text-sm">
					{#each snapshot.document.workflows as workflow}<li class="min-w-0">
							<button
								type="button"
								id="workflow-link-{workflow.id}"
								class="text-primary block max-w-full text-left break-words underline"
								onclick={(event) =>
									navigateTo({ kind: 'workflow', workflowId: workflow.id }, event.currentTarget)}
								>{workflow.name}</button
							>
						</li>{/each}
				</ul>
			</nav>
			{#each snapshot.document.workflows as workflow}<article
					class="mt-4 min-w-0 rounded-lg border p-4"
					id={targetId({ kind: 'workflow', workflowId: workflow.id })}
					tabindex="-1"
				>
					<h3 class="min-w-0 font-semibold break-words">
						{workflow.name}
						<span class="text-muted-foreground text-xs"
							>· {workflow.id === main.id ? 'main' : 'required dependency'}</span
						>
					</h3>
					{#if workflow.id !== main.id}<div class="mt-3">
							<PublicTextSnippet
								source={workflow.description || 'No description provided.'}
								uses={fieldUses(workflow.id, 'description')}
								fieldId={fieldId(workflow.id, 'description')}
								bind:expanded={expandedFields[fieldId(workflow.id, 'description')]}
								onToken={(inputId, _useId, trigger) =>
									navigateTo(
										{ kind: 'input', inputId },
										trigger,
										fieldId(workflow.id, 'description')
									)}
							/>
						</div>{/if}
					<!-- A named horizontal scroll region is intentionally keyboard-focusable. -->
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<div
						class="focus-visible:ring-ring mt-3 max-w-full min-w-0 overflow-x-auto focus-visible:ring-2"
						tabindex="0"
						role="region"
						aria-label={`${workflow.name} graph; scroll horizontally to inspect all states`}
					>
						<WorkflowGraph {workflow} fit={false} intrinsicScale={1.3} />
					</div>
					<div class="mt-3 grid min-w-0 gap-3" aria-label="States and applied instructions">
						{#each workflow.states as state}<article
								class="bg-muted/50 min-w-0 rounded p-3 break-words"
								id={targetId({ kind: 'state', stateId: state.id })}
								tabindex="-1"
							>
								<h4 class="text-sm font-semibold">
									{state.name} · {state.category}{#if state.inherits_from}
										· inherits
										<button
											type="button"
											class="text-primary underline"
											onclick={(event) =>
												navigateTo(
													{ kind: 'state', stateId: state.inherits_from!.state_id },
													event.currentTarget
												)}>{stateName(state.inherits_from.state_id)}</button
										>
									{/if}
								</h4>
								<p class="mt-2 text-xs font-medium">Applied instructions</p>
								<ol class="mt-1 space-y-1 text-xs">
									{#each publicInstructionLayers(snapshot.document, state.id) as layer}<li>
											<span class="font-medium"
												>{layer.local ? 'Local to' : 'Inherited from'}
												{layer.workflowName} › {layer.stateName}</span
											>
											{#if layer.items.length}<ul class="ml-4 list-disc">
													{#each layer.items as entry}<li>
															<button
																type="button"
																class="text-primary underline"
																onclick={(event) =>
																	navigateTo(
																		{
																			kind: 'field',
																			recordId: entry.item.id,
																			field: entry.item.description
																				? 'description'
																				: entry.item.kind === 'prompt'
																					? 'body'
																					: 'description'
																		},
																		event.currentTarget
																	)}>{entry.item.name}</button
															>{#if entry.overriddenBy}
																— overridden by
																<button
																	type="button"
																	class="text-primary underline"
																	onclick={(event) =>
																		navigateTo(
																			{
																				kind: 'field',
																				recordId: entry.overriddenBy!,
																				field: 'description'
																			},
																			event.currentTarget
																		)}>{entry.overriddenBy}</button
																>
															{/if}
														</li>{/each}
												</ul>{:else}<span class="text-muted-foreground">
													· no bundled items</span
												>{/if}
										</li>{/each}
								</ol>
							</article>{/each}
					</div>
					<ul class="mt-4 min-w-0 space-y-2 text-sm">
						{#each workflow.transitions as transition}<li class="min-w-0 break-words">
								<b class="break-words">{transition.name}</b> ·
								<button
									type="button"
									class="text-primary underline"
									onclick={(event) =>
										navigateTo(
											{ kind: 'state', stateId: transition.from_state_id },
											event.currentTarget
										)}>{stateName(transition.from_state_id)}</button
								>
								→
								<button
									type="button"
									class="text-primary underline"
									onclick={(event) =>
										navigateTo(
											{ kind: 'state', stateId: transition.to_state_id },
											event.currentTarget
										)}>{stateName(transition.to_state_id)}</button
								>{#if transition.requires.length}<ul class="min-w-0 list-disc pl-5">
										{#each transition.requires as gate}<li class="min-w-0 break-words">
												{gate.artifact} · {gate.type}{gate.content_type
													? ` · ${gate.content_type}`
													: ''} — {gate.description}
											</li>{/each}
									</ul>{:else}<span class="text-muted-foreground"> · no artifact gate</span>{/if}
							</li>{/each}
					</ul>
				</article>{/each}
		</section>
		<section class="py-6" aria-labelledby="instructions">
			<h2 id="instructions" class="text-xl font-semibold">
				Complete instructions and declarations
			</h2>
			<div class="mt-4 space-y-4">
				{#each snapshot.document.context as item, contextIndex}<article
						class="min-w-0 overflow-hidden rounded-lg border p-4 break-words"
					>
						<h3 class="min-w-0 font-semibold break-words">
							{item.name} <span class="text-muted-foreground text-xs">· {item.kind}</span>
						</h3>
						<p class="text-muted-foreground mt-1 text-xs">
							{contextIndex + 1} in bundled instruction order · declared on {stateName(
								item.state_id
							)}
						</p>
						<div class="mt-2">
							<PublicTextSnippet
								source={item.description || 'No description provided.'}
								uses={fieldUses(item.id, 'description')}
								fieldId={fieldId(item.id, 'description')}
								bind:expanded={expandedFields[fieldId(item.id, 'description')]}
								onToken={(inputId, _useId, trigger) =>
									navigateTo({ kind: 'input', inputId }, trigger, fieldId(item.id, 'description'))}
							/>
						</div>
						{#if item.kind === 'prompt'}<div class="mt-3">
								<PublicTextSnippet
									source={item.body}
									uses={fieldUses(item.id, 'body')}
									fieldId={fieldId(item.id, 'body')}
									bind:expanded={expandedFields[fieldId(item.id, 'body')]}
									onToken={(inputId, _useId, trigger) =>
										navigateTo({ kind: 'input', inputId }, trigger, fieldId(item.id, 'body'))}
								/>
							</div>{:else if item.kind === 'skill'}{#each item.files as file}<section class="mt-3">
									<h4 class="font-mono text-sm">{file.path}</h4>
									<div class="mt-2">
										<PublicTextSnippet
											source={file.content}
											format={fieldFormat(file.id)}
											uses={fieldUses(file.id, 'content')}
											fieldId={fieldId(file.id, 'content')}
											bind:expanded={expandedFields[fieldId(file.id, 'content')]}
											onToken={(inputId, _useId, trigger) =>
												navigateTo(
													{ kind: 'input', inputId },
													trigger,
													fieldId(file.id, 'content')
												)}
										/>
									</div>
								</section>{/each}{:else}<dl
								class="mt-3 grid grid-cols-[5rem_minmax(0,1fr)] gap-1 text-sm"
							>
								<dt>URL</dt>
								<dd class="font-mono break-all">{item.repo_url}</dd>
								<dt>Branch</dt>
								<dd class="min-w-0 break-all">{item.repo_branch ?? 'default'}</dd>
								<dt>Directory</dt>
								<dd>{item.repo_dir ?? 'root'}</dd>
							</dl>
							<p class="text-muted-foreground mt-2 text-xs">
								Declaration only. Repository contents are never fetched.
							</p>{/if}
					</article>{/each}
			</div>
		</section>
		<section class="grid min-w-0 gap-4 py-6 md:grid-cols-2">
			<article class="min-w-0 rounded-lg border p-4">
				<h2 class="font-semibold">Inputs</h2>
				<ul class="mt-2 space-y-2 text-sm">
					{#each snapshot.document.inputs as input}<li
							class="min-w-0 break-words"
							id={targetId({ kind: 'input', inputId: input.id })}
							tabindex="-1"
						>
							<code class="break-all">{input.key}</code> · {input.type} · {input.required
								? 'required'
								: 'optional'}<br />
							<span>{input.label}</span>{#if input.description}<span class="text-muted-foreground">
									— {input.description}</span
								>{/if}<br />
							<span class="text-muted-foreground break-all">Default: {input.default ?? 'none'}</span
							>
							{#if input.required_states?.length}<div class="mt-1">
									Required states: {input.required_states.join(', ')}
								</div>{/if}
							{#if inputUses(input.id).length}<ul class="mt-1 list-disc pl-5">
									{#each inputUses(input.id) as use}<li>
											<button
												type="button"
												id="reverse-{use.id}"
												class="text-primary text-left break-all underline"
												onclick={(event) =>
													navigateTo(
														{
															kind: 'field',
															recordId: use.target.record_id,
															field: use.target.field
														},
														event.currentTarget,
														targetId({ kind: 'input', inputId: input.id })
													)}>{use.token}</button
											>
											in {use.target.field}
										</li>{/each}
								</ul>{/if}
						</li>{/each}
				</ul>
			</article>
			<article class="min-w-0 rounded-lg border p-4">
				<h2 class="font-semibold">Selected automation</h2>
				<h3 class="mt-3 text-sm font-semibold">Schedules (installed paused)</h3>
				<ul class="mt-1 space-y-3 text-sm">
					{#each snapshot.document.schedules as schedule}<li class="min-w-0 break-words">
							<b>{schedule.name}</b> · {schedule.recurrence.kind === 'preset'
								? schedule.recurrence.preset
								: schedule.recurrence.cron} · {schedule.timezone}<br />
							Workflow:
							<button
								type="button"
								class="text-primary underline"
								onclick={(event) =>
									navigateTo(
										{ kind: 'workflow', workflowId: schedule.workflow.workflow_id },
										event.currentTarget
									)}>{workflowName(schedule.workflow.workflow_id)}</button
							>
							<div class="mt-2">
								<span class="text-xs font-medium">Title template</span>
								<PublicTextSnippet
									source={schedule.title_template}
									format="text"
									uses={fieldUses(schedule.id, 'title_template')}
									fieldId={fieldId(schedule.id, 'title_template')}
									bind:expanded={expandedFields[fieldId(schedule.id, 'title_template')]}
									onToken={(inputId, _useId, trigger) =>
										navigateTo(
											{ kind: 'input', inputId },
											trigger,
											fieldId(schedule.id, 'title_template')
										)}
								/>
							</div>
							<div class="mt-2">
								<span class="text-xs font-medium">Description template</span>
								<PublicTextSnippet
									source={schedule.description_template}
									format="text"
									uses={fieldUses(schedule.id, 'description_template')}
									fieldId={fieldId(schedule.id, 'description_template')}
									bind:expanded={expandedFields[fieldId(schedule.id, 'description_template')]}
									onToken={(inputId, _useId, trigger) =>
										navigateTo(
											{ kind: 'input', inputId },
											trigger,
											fieldId(schedule.id, 'description_template')
										)}
								/>
							</div>
						</li>{/each}
					{#if !snapshot.document.schedules.length}<li class="text-muted-foreground">
							No schedules selected.
						</li>{/if}
				</ul>
				<h3 class="mt-4 text-sm font-semibold">Routing preferences</h3>
				<ul class="mt-1 space-y-1 text-sm">
					{#each snapshot.document.routing as route}<li class="break-words">
							<button
								type="button"
								class="text-primary underline"
								onclick={(event) =>
									navigateTo({ kind: 'state', stateId: route.scope.state_id }, event.currentTarget)}
								>{stateName(route.scope.state_id)}</button
							>
							· {route.tier}{route.scope.project ? ' · project-scoped' : ''}
						</li>{/each}
					{#if !snapshot.document.routing.length}<li class="text-muted-foreground">
							No routing preferences selected.
						</li>{/if}
				</ul>
			</article>
		</section>
		<footer
			class="text-muted-foreground flex flex-wrap items-center justify-between gap-3 border-t py-6 text-xs break-all"
		>
			<div class="min-w-0">
				<a class="underline" href="/public-workflow-policy" rel="noreferrer">Content rules</a
				><TechnicalDetails
					items={[
						{ label: 'Document fingerprint', value: snapshot.document_digest },
						{ label: 'File fingerprint', value: snapshot.bytes_sha256 }
					]}
				/>
			</div>
			<button
				class="focus-visible:ring-ring/50 min-h-10 rounded-md border px-3 text-sm outline-none focus-visible:ring-[3px]"
				type="button"
				onclick={(event) => reportDialog?.show(event.currentTarget)}>Report this workflow</button
			>
		</footer>
	</main>
	{#if !data.user}<MarketingSignIn
			bind:this={signIn}
			returnTo={installReturn}
			errorReturnTo={signInErrorReturn}
			{linkError}
		/>{/if}
{:else}
	<main class="mx-auto flex min-h-screen max-w-xl items-center px-6">
		<div>
			<h1 class="text-2xl font-semibold">Publication unavailable</h1>
			<p class="text-muted-foreground mt-3">This publication is not available.</p>
		</div>
	</main>
{/if}
{#if visible}<PublicationReportDialog
		bind:this={reportDialog}
		snapshotId={snapshot.snapshot_id}
	/>{/if}
