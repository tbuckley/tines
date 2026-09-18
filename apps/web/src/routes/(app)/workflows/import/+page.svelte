<script lang="ts">
	import {
		ApiError,
		ApiNetworkError,
		canonicalizeLibraryValue,
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
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import PackageInputs from '$lib/components/library/PackageInputs.svelte';
	import PackageOperations from '$lib/components/library/PackageOperations.svelte';
	import PackageReceipt from '$lib/components/library/PackageReceipt.svelte';
	import TechnicalDetails from '$lib/components/publications/TechnicalDetails.svelte';
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
	let hostedChecking = false;
	const hostedSnapshotId = $derived(page.url.searchParams.get('publication'));
	const hostedMode = $derived(!!hostedSnapshotId);

	const requiredReviewIds = $derived(
		document_?.context
			.filter((item) => item.kind === 'skill' || item.kind === 'repo')
			.map((item) => item.id) ?? []
	);
	const canRetry = $derived(!!recovery && document_?.digest === recovery.documentDigest);
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
	async function revealReceipt(): Promise<void> {
		await tick();
		const heading = document.querySelector<HTMLElement>('[data-package-receipt-title]');
		if (!heading) return;
		heading.focus({ preventScroll: true });
		heading.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
	}
	function captureErrorDetails(err: unknown) {
		if (err instanceof ApiError) {
			errorCode = err.code;
			const target = String(err.details?.input_id ?? err.details?.record_id ?? '');
			errorTarget = target || null;
			if (target)
				setTimeout(
					() => document.getElementById(`input-${target}`)?.scrollIntoView({ block: 'center' }),
					0
				);
			return;
		}
		errorCode = null;
		errorTarget = null;
	}
	function describe(err: unknown, fallback: string) {
		captureErrorDetails(err);
		if (err instanceof ApiError) return err.message;
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
		document_ = null;
		documentJson = '';
		try {
			documentJson = await file.text();
			const loose = parseStrictLibraryJson(documentJson) as {
				version?: unknown;
				profile?: unknown;
			};
			if (loose.version !== 3 || loose.profile !== 'workflow') {
				legacyFile = !recovery;
				stage = recovery ? 'unknown' : 'values';
				if (recovery) {
					error =
						'Choose the original workflow package file to retry this installation, or choose Check result.';
					await focusError();
				}
				return;
			}
			const result = await api.validateLibrary({ document_json: documentJson });
			if (!result.valid || !result.document || result.document.profile !== 'workflow') {
				error = recovery
					? 'Choose the original workflow package file to retry this installation, or choose Check result.'
					: result.diagnostics.map((d) => `${d.path || '/'}: ${d.message}`).join('\n') ||
						'This workflow package is invalid.';
				stage = recovery ? 'unknown' : 'values';
				await focusError();
				return;
			}
			if (recovery && recovery.documentDigest !== result.document.digest) {
				error =
					'This file does not match the installation awaiting recovery. Choose the original workflow package file.';
				stage = 'unknown';
				await focusError();
				return;
			}
			document_ = result.document;
			choices = { schedule_ids: [] };
			stage = recovery ? 'unknown' : 'values';
		} catch (err) {
			if (recovery) {
				captureErrorDetails(err);
				error =
					'Choose the original workflow package file to retry this installation, or choose Check result.';
			} else error = describe(err, 'That file is not valid Tines library JSON.');
			stage = recovery ? 'unknown' : 'values';
			await focusError();
		}
	}

	async function prepare() {
		if (!document_ || recovery) return;
		stage = 'preparing';
		error = null;
		errorCode = null;
		errorTarget = null;
		confirmed = false;
		try {
			plan = hostedSnapshotId
				? await api.prepareHostedWorkflowPackage(hostedSnapshotId, choices)
				: await api.prepareWorkflowPackage({ document_json: documentJson, choices });
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
		if (
			recovery &&
			(!canRetry ||
				recovery.planId !== planId ||
				recovery.planDigest !== digest ||
				recovery.planToken !== token)
		)
			return;
		const retryingUnknown = stage === 'unknown';
		stage = 'installing';
		error = null;
		errorCode = null;
		errorTarget = null;
		if (!recovery)
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
			await revealReceipt();
		} catch (err) {
			if (
				err instanceof ApiNetworkError ||
				(err instanceof ApiError && err.code === 'install_outcome_unknown')
			) {
				stage = 'unknown';
				errorCode = 'install_outcome_unknown';
				errorTarget = null;
				error =
					'We could not confirm whether installation finished. Choose Check result before retrying.';
			} else if (retryingUnknown) {
				// Rejection of a retry says nothing about the original uncertain request.
				stage = 'unknown';
				captureErrorDetails(err);
				error =
					'The retry did not finish. The original installation result is still unknown. Choose Check result before taking further action.';
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
				captureErrorDetails(err);
				error =
					err.code === 'plan_stale'
						? 'The preview expired or the destination changed. Nothing was created by this rejected attempt. Choose Preview installation and review it again.'
						: 'The file or confirmation no longer matches the preview. Nothing was created by this rejected attempt. Choose Preview installation and review it again.';
			} else {
				clearRecovery();
				stage = 'prepared';
				captureErrorDetails(err);
				error =
					'Installation did not finish. Your reviewed choices are still available. Choose Install workflow to retry.';
			}
			await focusError();
		}
	}
	async function install() {
		if (plan && confirmed && reviewComplete) {
			if (hostedSnapshotId) {
				try {
					await api.getPublicSnapshotStatus(hostedSnapshotId);
				} catch {
					plan = null;
					document_ = null;
					documentJson = '';
					stage = 'values';
					error = 'This publication is not available.';
					await focusError();
					return;
				}
			}
			await installExact(plan.plan_token, plan.plan_digest, plan.plan_id);
		}
	}
	async function checkResult() {
		if (!recovery) return;
		error = null;
		errorCode = null;
		errorTarget = null;
		try {
			receipt = await api.getWorkflowPackageReceipt(recovery.planId);
			clearRecovery();
			stage = 'receipt';
			await revealReceipt();
		} catch (err) {
			captureErrorDetails(err);
			if (err instanceof ApiError && err.status === 404)
				error =
					'No result is available yet. Installation may still be running. Choose Check result again, or retry the same installation.';
			else
				error = 'The installation result could not be checked. Choose Check result to try again.';
			stage = 'unknown';
			await focusError();
		}
	}

	function clearHostedReview() {
		document_ = null;
		documentJson = '';
		plan = null;
		confirmed = false;
		reviewed = new Set();
		stage = 'reading';
	}

	async function loadHostedSnapshot() {
		if (!hostedSnapshotId || recovery || hostedChecking) return;
		hostedChecking = true;
		clearHostedReview();
		try {
			await api.getPublicSnapshotStatus(hostedSnapshotId);
			const snapshot = await api.getPublicSnapshot(hostedSnapshotId);
			document_ = snapshot.document;
			documentJson = canonicalizeLibraryValue(snapshot.document);
			fileName = `public-${hostedSnapshotId}.json`;
			choices = { schedule_ids: [] };
			stage = 'values';
			error = null;
		} catch {
			clearHostedReview();
			stage = 'values';
			errorCode = null;
			errorTarget = null;
			error = 'This publication is not available.';
			await focusError();
		} finally {
			hostedChecking = false;
		}
	}

	onMount(() => {
		void (async () => {
			try {
				const value = JSON.parse(sessionStorage.getItem(recoveryKey) ?? 'null') as Recovery | null;
				if (value?.actorId === data.user.id && value.destination === location.origin) {
					recovery = value;
					stage = 'unknown';
				} else if (value) sessionStorage.removeItem(recoveryKey);
			} catch {
				clearRecovery();
			}
			await loadHostedSnapshot();
		})();
		const resumed = () => {
			if (['values', 'prepared', 'preparing'].includes(stage)) void loadHostedSnapshot();
		};
		const timer = setInterval(() => {
			if (!document.hidden) resumed();
		}, 15_000);
		addEventListener('focus', resumed);
		addEventListener('pageshow', resumed);
		return () => {
			clearInterval(timer);
			removeEventListener('focus', resumed);
			removeEventListener('pageshow', resumed);
		};
	});
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape' && tokenInvoker) backToToken();
	}}
/>

<svelte:head><title>Install workflow · Tines</title></svelte:head>

<div class="mx-auto max-w-[68rem] min-w-0 pb-20">
	<a
		href="/workflows"
		class="text-muted-foreground mb-4 inline-flex min-h-10 items-center gap-1 text-sm hover:underline"
		><IconArrowLeft size={15} /> Workflows</a
	>
	<h1 class="text-2xl font-semibold tracking-tight">Install workflow</h1>
	<p class="text-muted-foreground mt-2 mb-6 max-w-3xl text-sm">
		{hostedMode
			? 'Preview this shared workflow, choose its values, and install an independent copy.'
			: 'Preview a local workflow file, choose its values, and install an independent copy.'}
	</p>

	{#if !hostedMode}<div class="mb-6 flex flex-wrap items-center gap-3 rounded-lg border p-4">
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
			{#if document_}<TechnicalDetails
					items={[{ label: 'Document fingerprint', value: document_.digest }]}
				/>{/if}
		</div>{/if}

	{#if error}<div
			bind:this={alertEl}
			tabindex="-1"
			role="alert"
			class="border-destructive/40 bg-destructive/5 text-destructive mb-5 rounded-lg border p-3 text-sm whitespace-pre-wrap"
		>
			{error}
			{#if errorAction}<a class="ml-2 underline" href={errorAction.href}>{errorAction.label}</a
				>{/if}
			{#if errorCode}<TechnicalDetails items={[{ label: 'Error code', value: errorCode }]} />{/if}
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
			Choose a workflow package file to check what it includes. Nothing is installed until you
			review and confirm.
		</p>
	{:else if stage === 'reading'}
		<p role="status" class="text-muted-foreground text-sm">Reading and validating package…</p>
	{:else if stage === 'unknown'}
		<section class="space-y-3 rounded-lg border p-4">
			<h2 class="font-semibold">Installation status is unknown</h2>
			<p class="text-muted-foreground text-sm">
				Choose Check result to see whether this installation finished. Any retry uses the same file
				and choices in this account.
			</p>
			<div class="flex flex-wrap gap-2">
				<Button onclick={checkResult}><IconRefresh size={16} /> Check result</Button
				>{#if recovery}<Button
						disabled={!canRetry}
						variant="outline"
						onclick={() =>
							installExact(recovery!.planToken, recovery!.planDigest, recovery!.planId)}
						>Retry installation</Button
					>{/if}
			</div>
			{#if !hostedMode && !document_}<p class="text-muted-foreground text-xs">
					To retry after checking, choose the same workflow package file again. Its contents must
					match the original.
				</p>{/if}
			{#if recovery}<TechnicalDetails
					items={[
						{ label: 'Plan ID', value: recovery.planId },
						{ label: 'Plan digest', value: recovery.planDigest },
						{ label: 'Document digest', value: recovery.documentDigest }
					]}
				/>{/if}
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
				/><PackageOperations {plan} onToken={focusInput} />{/if}
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
					<Button size="sm" variant="outline" onclick={backToToken}>Back to passage</Button>
				</div>{/if}
			{#if !plan}<Button onclick={prepare} disabled={stage === 'preparing'}
					>{stage === 'preparing' ? 'Preparing preview…' : 'Preview installation'}</Button
				>{/if}
		</div>
	{/if}
</div>

{#if stage === 'prepared' && plan}
	<div
		class="bg-background/95 fixed inset-x-0 bottom-[calc(4rem+1px+env(safe-area-inset-bottom,0px))] z-30 border-t px-4 py-2 backdrop-blur md:bottom-0"
		data-testid="install-actions"
	>
		<div class="mx-auto flex min-h-10 max-w-[68rem] flex-wrap items-center justify-between gap-2">
			<label class="flex min-h-10 items-center gap-2 text-sm"
				><input type="checkbox" bind:checked={confirmed} /> I reviewed what will be installed</label
			>
			<Button onclick={install} disabled={!confirmed || !reviewComplete}>Install workflow</Button>
		</div>
		{#if !reviewComplete}<p class="text-muted-foreground mx-auto max-w-[68rem] text-right text-xs">
				Review every included skill and repository before installing.
			</p>{/if}
		<TechnicalDetails
			items={[
				{ label: 'Plan', value: plan.plan_id },
				{ label: 'Plan fingerprint', value: plan.plan_digest },
				{ label: 'Expires', value: new Date(plan.expires_at).toLocaleString() }
			]}
		/>
	</div>
{/if}
