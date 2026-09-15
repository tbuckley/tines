<script lang="ts">
	import {
		moderationTextLength,
		type PublicationReportReason,
		type PublicationReportRequest,
		type PublicationReportReceipt
	} from '@tines/shared';
	import Modal from '$lib/components/Modal.svelte';

	let { snapshotId }: { snapshotId: string } = $props();
	let open = $state(false);
	let reason = $state<PublicationReportReason | ''>('');
	let note = $state('');
	let pending = $state(false);
	let error = $state('');
	let receipt = $state<PublicationReportReceipt | null>(null);
	let frozen = $state<PublicationReportRequest | null>(null);
	let retryAt = $state<number | null>(null);
	let errorElement = $state<HTMLParagraphElement | null>(null);
	const noteLength = $derived(moderationTextLength(note));

	export function show(trigger: HTMLElement) {
		receipt = null;
		error = '';
		retryAt = null;
		open = true;
		trigger.focus();
	}

	async function submit() {
		if (!reason) {
			error = 'Choose a reason.';
			errorElement?.focus();
			return;
		}
		if (noteLength > 1000) {
			error = 'Details must be 1,000 characters or fewer.';
			return;
		}
		pending = true;
		error = '';
		const payload =
			frozen ??
			({
				request_id: crypto.randomUUID(),
				reason,
				...(note ? { note } : {})
			} satisfies PublicationReportRequest);
		frozen = payload;
		try {
			const response = await fetch(`/api/v1/publications/public/${snapshotId}/reports`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload)
			});
			const body = await response.json();
			if (!response.ok) {
				if (response.status === 429) retryAt = body?.error?.details?.retry_at ?? null;
				if (response.status !== 503 && response.status !== 429) frozen = null;
				throw new Error(body?.error?.message ?? 'The report could not be received.');
			}
			receipt = body as PublicationReportReceipt;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'The report could not be received.';
		} finally {
			pending = false;
		}
	}

	function reset() {
		reason = '';
		note = '';
		frozen = null;
		receipt = null;
		error = '';
		retryAt = null;
	}
</script>

<Modal
	bind:open
	title={receipt ? 'Report received' : 'Report this public workflow'}
	onclose={reset}
>
	{#if receipt}
		<p>Your report is private and will be reviewed by the host team.</p>
		<p class="bg-muted mt-4 rounded-md p-3 font-mono text-sm break-all" tabindex="-1">
			Reference: {receipt.receipt.reference}
		</p>
		<p class="text-muted-foreground mt-3 text-xs">
			Keep this reference. It does not reveal the report or moderation status.
		</p>
		<button
			class="bg-primary text-primary-foreground mt-5 min-h-10 rounded-md px-4"
			onclick={() => (open = false)}
		>
			Done
		</button>
	{:else}
		<form
			onsubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<label class="block text-sm font-medium" for="report-reason">Reason</label>
			<select
				id="report-reason"
				class="mt-1 min-h-10 w-full rounded-md border bg-transparent px-3"
				bind:value={reason}
				disabled={pending}
			>
				<option value="">Choose a reason</option>
				<option value="harmful_abusive">Harmful or abusive content</option>
				<option value="malicious_phishing">Malicious instructions or phishing</option>
				<option value="private_information">Private information</option>
				<option value="rights">Rights concern</option>
				<option value="other">Other</option>
			</select>
			<label class="mt-4 block text-sm font-medium" for="report-note">Details (optional)</label>
			<textarea
				id="report-note"
				class="mt-1 min-h-28 w-full rounded-md border bg-transparent p-3"
				bind:value={note}
				disabled={pending}></textarea>
			<p
				class="text-muted-foreground mt-1 text-right text-xs"
				class:text-destructive={noteLength > 1000}
			>
				{noteLength} / 1,000
			</p>
			{#if error}
				<p
					class="text-destructive mt-3 text-sm"
					role="alert"
					tabindex="-1"
					bind:this={errorElement}
				>
					{error}
				</p>
			{/if}
			{#if retryAt}
				<p class="text-muted-foreground mt-2 text-xs">
					Try again after {new Date(retryAt).toLocaleTimeString()}.
				</p>
			{/if}
			<div class="mt-5 flex flex-wrap gap-2">
				<button
					class="bg-primary text-primary-foreground min-h-10 rounded-md px-4 disabled:opacity-50"
					disabled={pending || noteLength > 1000}
				>
					{pending ? 'Sending…' : frozen ? 'Retry report' : 'Send report'}
				</button>
				<button
					type="button"
					class="min-h-10 rounded-md border px-4"
					disabled={pending}
					onclick={() => (open = false)}>Cancel</button
				>
			</div>
		</form>
	{/if}
</Modal>
