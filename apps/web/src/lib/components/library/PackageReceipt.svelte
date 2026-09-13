<script lang="ts">
	import type { WorkflowPackageReceipt } from '@tines/shared';
	import IconCircleCheck from '@tabler/icons-svelte/icons/circle-check';
	let { receipt }: { receipt: WorkflowPackageReceipt } = $props();
</script>

<section class="space-y-4" aria-labelledby="receipt-title" data-package-receipt>
	<div>
		<h2
			id="receipt-title"
			class="flex scroll-mt-20 items-center gap-2 text-xl font-semibold"
			tabindex="-1"
			data-package-receipt-title
		>
			<IconCircleCheck class="shrink-0" size={20} stroke={1.5} aria-hidden="true" />
			Package installed
		</h2>
		<p class="text-muted-foreground mt-1 text-sm">
			Created as an independent copy. Selected schedules are paused with no runs or issues created.
			No project default changed, and installation did not launch work.
		</p>
	</div>
	<p class="text-xs">
		<b>Receipt</b> <code>{receipt.id}</code> · {new Date(receipt.committed_at).toLocaleString()}
	</p>
	<ul class="divide-y rounded-lg border text-sm">
		{#each receipt.objects as object (object.kind + object.id)}
			<li class="flex min-h-10 flex-wrap items-center justify-between gap-2 p-3">
				<span
					>{object.kind} · {object.name}{object.relationship
						? ` · ${object.relationship}`
						: ''}</span
				>
				<a class="text-primary underline" href={object.href}>Open {object.kind}</a>
			</li>
		{/each}
	</ul>
	{#if receipt.reused_inputs.length}<div>
			<h3 class="text-sm font-semibold">Reused destination objects</h3>
			<ul class="mt-1 text-sm">
				{#each receipt.reused_inputs as input}<li>{input.type} · {input.name}</li>{/each}
			</ul>
		</div>{/if}
</section>
