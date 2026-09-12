<script lang="ts">
	import {
		ApiError,
		ApiNetworkError,
		parseStrictLibraryJson,
		type PrepareWorkflowPackageResponse,
		type WorkflowPackageChoices,
		type WorkflowPackageDocument,
		type WorkflowPackageReceipt
	} from '@tines/shared';
	import IconArrowLeft from '@tabler/icons-svelte/icons/arrow-left';
	import IconRefresh from '@tabler/icons-svelte/icons/refresh';
	import IconUpload from '@tabler/icons-svelte/icons/upload';
	import { onMount, tick } from 'svelte';
	import { api } from '$lib/api';
	import PackageInputs from '$lib/components/library/PackageInputs.svelte';
	import PackageOperations from '$lib/components/library/PackageOperations.svelte';
	import PackageReceipt from '$lib/components/library/PackageReceipt.svelte';
	import PackageReview from '$lib/components/library/PackageReview.svelte';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';

	let { data } = $props();
	type Stage =
		| 'empty'
		| 'reading'
		| 'values'
		| 'preparing'
		| 'prepared'
		| 'installing'
		| 'receipt'
		| 'unknown';
	type Recovery = {
		actorId: string;
		destination: string;
		planId: string;
		planDigest: string;
		documentDigest: string;
		planToken: string;
		createdAt: number;
	};
	const recoveryKey = 'tines:workflow-package-install-recovery:v1';

	let stage = $state<Stage>('empty');
	let fileName = $state<string | null>(null);
	let documentJson = $state('');
	let document_ = $state<WorkflowPackageDocument | null>(null);
	let choices = $state<WorkflowPackageChoices>({ schedule_ids: [] });
	let plan = $state<PrepareWorkflowPackageResponse | null>(null);
	let receipt = $state<WorkflowPackageReceipt | null>(null);
	let recovery = $state<Recovery | null>(null);
	let confirmed = $state(false);
	let reviewed = $state(new Set<string>());
	let error = $state<string | null>(null);
	let errorCode = $state<string | null>(null);
	let errorTarget = $state<string | null>(null);
	let legacyFile = $state(false);
	let alertEl = $state<HTMLElement | null>(null);
	let tokenInvoker = $state<HTMLElement | null>(null);

	const requiredReviewIds = $derived(
		document_?.context
			.filter((item) => item.kind === 'skill' || item.kind === 'repo')
			.map((item) => item.id) ?? []
	);
	const reviewComplete = $derived(requiredReviewIds.every((id) => reviewed.has(id)));
	const errorAction = $derived.by(() => {
		if (errorCode === 'routing_unavailable')
			return { href: '/agents#routing', label: 'Configure destination runners' };
		const input = document_?.inputs.find((item) => item.id === errorTarget);
		if (
			input?.type === 'workflow' &&
			['missing_input', 'not_found', 'missing_required_states'].includes(errorCode ?? '')
		)
			return { href: '/workflows/new', label: 'Create a destination workflow' };
		return null;
	});
	const resolvedDocument = $derived.by(() => {
		if (!plan) return null;
		const current = plan;
		return {
			...current.document,
			workflows: current.resolved.workflows,
			context: current.resolved.context,
			schedules: current.resolved.schedules.map((schedule) => schedule.definition),
			routing: current.document.routing
				.filter((route) =>
					current.resolved.routing.some((resolved) => resolved.local_id === route.id)
				)
				.map((route) => ({
					...route,
					tier: current.resolved.routing.find((resolved) => resolved.local_id === route.id)!.tier
				}))
		};
	});

	function clearRecovery() {
		recovery = null;
		try {
			sessionStorage.removeItem(recoveryKey);
		} catch {
			/* in-memory recovery remains enough for this page */
		}
	}
	function saveRecovery(next: Recovery) {
		recovery = next;
		try {
			sessionStorage.setItem(recoveryKey, JSON.stringify(next));
		} catch {
			/* browser storage is optional */
		}
	}
	async function focusError() {
		await tick();
		alertEl?.focus();
	}
	function describe(err: unknown, fallback: string) {
		if (err instanceof ApiError) {
			errorCode = err.code;
			const target = String(err.details?.input_id ?? err.details?.record_id ?? '');
			errorTarget = target || null;
			if (target)
				setTimeout(
					() => document.getElementById(`input-${target}`)?.scrollIntoView({ block: 'center' }),
					0
				);
			return err.message;
		}
		errorCode = null;
		errorTarget = null;
		return fallback;
	}
	function invalidatePlan(next: WorkflowPackageChoices) {
		choices = next;
		plan = null;
		confirmed = false;
		reviewed = new Set();
		error = null;
		errorCode = null;
		errorTarget = null;
		stage = 'values';
	}
	async function focusInput(id: string, trigger: HTMLElement) {
		tokenInvoker = trigger;
		await tick();
		const input = document.getElementById(`value-${id}`);
		input?.focus();
		input?.scrollIntoView({ block: 'center' });
	}
	function backToToken() {
		tokenInvoker?.focus();
		tokenInvoker = null;
	}

	async function chooseFile(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		stage = 'reading';
		error = null;
		errorCode = null;
		errorTarget = null;
		legacyFile = false;
		receipt = null;
		plan = null;
		confirmed = false;
		reviewed = new Set();
		fileName = file.name;
		try {
			documentJson = await file.text();
			const loose = parseStrictLibraryJson(documentJson) as {
				version?: unknown;
				profile?: unknown;
			};
			if (loose.version !== 3 || loose.profile !== 'workflow') {
				legacyFile = true;
				document_ = null;
				stage = 'values';
				return;
			}
			const result = await api.validateLibrary({ document_json: documentJson });
			if (!result.valid || !result.document || result.document.profile !== 'workflow') {
				error =
					result.diagnostics.map((d) => `${d.path || '/'}: ${d.message}`).join('\n') ||
					'This workflow package is invalid.';
				stage = 'values';
				await focusError();
				return;
			}
			document_ = result.document;
			choices = { schedule_ids: [] };
			if (recovery && recovery.documentDigest !== document_.digest) {
				error = 'This file does not match the installation awaiting recovery.';
				stage = 'unknown';
				await focusError();
				return;
			}
			stage = recovery ? 'unknown' : 'values';
		} catch (err) {
			error = describe(err, 'That file is not valid Tines library JSON.');
			stage = 'values';
			await focusError();
		}
	}

	async function prepare() {
		if (!document_) return;
		stage = 'preparing';
		error = null;
		errorCode = null;
		errorTarget = null;
		confirmed = false;
		try {
			plan = await api.prepareWorkflowPackage({ document_json: documentJson, choices });
			choices = plan.resolved.choices;
			stage = 'prepared';
		} catch (err) {
			stage = 'values';
			error = describe(err, 'The package could not be prepared.');
			await focusError();
		}
	}

	async function installExact(token: string, digest: string, planId: string) {
		if (!document_) return;
		stage = 'installing';
		error = null;
		errorCode = null;
		saveRecovery({
			actorId: data.user.id,
			destination: location.origin,
			planId,
			planDigest: digest,
			documentDigest: document_.digest,
			planToken: token,
			createdAt: Date.now()
		});
		try {
			receipt = await api.installWorkflowPackage({
				document_json: documentJson,
				plan_token: token,
				confirmation: { plan_digest: digest }
			});
			clearRecovery();
			stage = 'receipt';
			await tick();
			document.querySelector<HTMLElement>('[data-package-receipt]')?.focus();
		} catch (err) {
			if (
				err instanceof ApiNetworkError ||
				(err instanceof ApiError && err.code === 'install_outcome_unknown')
			) {
				stage = 'unknown';
				errorCode = 'install_outcome_unknown';
				error =
					'Installation result unknown. The request may still have committed; check the durable receipt before retrying.';
			} else if (
				err instanceof ApiError &&
				(err.code === 'plan_stale' ||
					err.code === 'package_changed' ||
					err.code === 'confirmation_mismatch')
			) {
				clearRecovery();
				plan = null;
				confirmed = false;
				stage = 'values';
				error = `${err.message}. Nothing was created by this rejected attempt. Prepare and confirm a fresh plan.`;
				errorCode = err.code;
			} else {
				stage = 'prepared';
				error = describe(
					err,
					'Installation rolled back. The prepared plan is preserved so you can retry it.'
				);
			}
			await focusError();
		}
	}
	async function install() {
		if (plan && confirmed && reviewComplete)
			await installExact(plan.plan_token, plan.plan_digest, plan.plan_id);
	}
	async function checkResult() {
		if (!recovery) return;
		error = null;
		try {
			receipt = await api.getWorkflowPackageReceipt(recovery.planId);
			clearRecovery();
			stage = 'receipt';
			await tick();
			document.querySelector<HTMLElement>('[data-package-receipt]')?.focus();
		} catch (err) {
			if (err instanceof ApiError && err.status === 404)
				error =
					'No receipt is visible yet. The request may still be in flight; this is not proof of rollback. Check again or safely retry this same plan.';
			else error = describe(err, 'The receipt could not be checked.');
			stage = 'unknown';
			await focusError();
		}
	}

	onMount(() => {
		try {
			const value = JSON.parse(sessionStorage.getItem(recoveryKey) ?? 'null') as Recovery | null;
			if (value?.actorId === data.user.id && value.destination === location.origin) {
				recovery = value;
				stage = 'unknown';
			} else if (value) sessionStorage.removeItem(recoveryKey);
		} catch {
			clearRecovery();
		}
	});
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape' && tokenInvoker) backToToken();
	}}
/>

<svelte:head><title>Install workflow package · Tines</title></svelte:head>

<div class="mx-auto max-w-[68rem] min-w-0 pb-20">
	<a
		href="/workflows"
		class="text-muted-foreground mb-4 inline-flex min-h-10 items-center gap-1 text-sm hover:underline"
		><IconArrowLeft size={15} /> Workflows</a
	>
	<h1 class="text-2xl font-semibold tracking-tight">Install workflow package</h1>
	<p class="text-muted-foreground mt-2 mb-6 max-w-3xl text-sm">
		Review a local Tines package, resolve its destination values, and install one atomic independent
		copy. This page never fetches package dependencies or public URLs.
	</p>

	<div class="mb-6 flex flex-wrap items-center gap-3 rounded-lg border p-4">
		<label
			class="{buttonVariants({
				variant: 'outline'
			})} focus-within:border-ring focus-within:ring-ring/50 cursor-pointer focus-within:ring-[3px]"
		>
			<input
				type="file"
				accept="application/json,.json"
				onchange={chooseFile}
				class="sr-only"
				aria-label="Workflow package file"
				disabled={stage === 'reading' || stage === 'preparing' || stage === 'installing'}
			/>
			<IconUpload size={16} />
			{document_ ? 'Choose another file' : 'Choose package file'}
		</label>
		<span class="text-muted-foreground min-w-0 text-sm break-all"
			>{fileName ?? 'No file chosen'}</span
		>
		{#if document_}<span
				class="text-muted-foreground max-w-full min-w-0 text-xs break-all sm:w-auto"
				><code>{document_.digest}</code></span
			>{/if}
	</div>

	{#if error}<div
			bind:this={alertEl}
			tabindex="-1"
			role="alert"
			class="border-destructive/40 bg-destructive/5 text-destructive mb-5 rounded-lg border p-3 text-sm whitespace-pre-wrap"
		>
			<b>{errorCode ? `${errorCode}: ` : ''}</b>{error}
			{#if errorAction}<a class="ml-2 underline" href={errorAction.href}>{errorAction.label}</a
				>{/if}
		</div>{/if}

	{#if legacyFile}
		<section class="rounded-lg border p-4">
			<h2 class="font-semibold">Whole-library import</h2>
			<p class="text-muted-foreground mt-1 mb-3 text-sm">
				This is a legacy or whole-library file. It uses the existing best-effort review, where valid
				entries may install independently.
			</p>
			<Button href="/settings/export-import">Open whole-library importer</Button>
		</section>
	{:else if stage === 'empty'}
		<p class="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
			Choose a local JSON package to validate it. Nothing is uploaded or installed until you confirm
			a prepared plan.
		</p>
	{:else if stage === 'reading'}
		<p role="status" class="text-muted-foreground text-sm">Reading and validating package…</p>
	{:else if stage === 'unknown'}
		<section class="space-y-3 rounded-lg border p-4">
			<h2 class="font-semibold">Installation result unknown</h2>
			<p class="text-muted-foreground text-sm">
				Recovery is scoped to this account, destination, and prepared plan. The saved recovery
				record contains the signed plan identity, not package prose.
			</p>
			<div class="flex flex-wrap gap-2">
				<Button onclick={checkResult}><IconRefresh size={16} /> Check result</Button
				>{#if document_ && recovery}<Button
						variant="outline"
						onclick={() =>
							installExact(recovery!.planToken, recovery!.planDigest, recovery!.planId)}
						>Retry same plan safely</Button
					>{/if}
			</div>
			{#if !document_}<p class="text-muted-foreground text-xs">
					To retry after checking, choose the exact same package file again. A different digest is
					refused.
				</p>{/if}
		</section>
	{:else if receipt}
		<PackageReceipt {receipt} />
	{:else if document_}
		<div class="space-y-8">
			{#if plan && resolvedDocument}<PackageReview
					document={resolvedDocument}
					{reviewed}
					onReview={(id, checked) => {
						const next = new Set(reviewed);
						checked ? next.add(id) : next.delete(id);
						reviewed = next;
					}}
					onToken={focusInput}
				/><PackageOperations {plan} />{/if}
			<PackageInputs
				document={document_}
				{choices}
				projects={data.projects}
				workflows={data.workflows}
				labels={data.labels}
				disabled={stage === 'preparing' || stage === 'installing'}
				onchange={invalidatePlan}
			/>
			{#if tokenInvoker}<div class="flex justify-end">
					<Button size="sm" variant="outline" onclick={backToToken}>Back to exact use</Button>
				</div>{/if}
			{#if !plan}<Button onclick={prepare} disabled={stage === 'preparing'}
					>{stage === 'preparing' ? 'Preparing exact plan…' : 'Prepare installation'}</Button
				>{/if}
		</div>
	{/if}
</div>

{#if stage === 'prepared' && plan}
	<div
		class="bg-background/95 fixed inset-x-0 bottom-14 z-30 border-t px-4 py-2 backdrop-blur sm:bottom-0"
	>
		<div class="mx-auto flex min-h-10 max-w-[68rem] flex-wrap items-center justify-between gap-2">
			<label class="flex min-h-10 items-center gap-2 text-sm"
				><input type="checkbox" bind:checked={confirmed} /> I confirm exact plan
				<code class="hidden lg:inline">{plan.plan_digest}</code></label
			>
			<Button onclick={install} disabled={!confirmed || !reviewComplete}>Install package</Button>
		</div>
		{#if !reviewComplete}<p class="text-muted-foreground mx-auto max-w-[68rem] text-right text-xs">
				Review every included skill and repository before confirming.
			</p>{/if}
	</div>
{/if}
