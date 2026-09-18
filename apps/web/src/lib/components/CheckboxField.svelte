<script lang="ts">
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';

	let {
		checked = false,
		label,
		disabled = false,
		title = undefined,
		class: className = '',
		onCheckedChange
	}: {
		checked?: boolean;
		label: string;
		disabled?: boolean;
		title?: string | undefined;
		class?: string;
		onCheckedChange: (checked: boolean) => void;
	} = $props();
</script>

<!--
  The checkbox is a button, not an `<input>`, so the wrapping `<label>` gives it
  click-to-toggle (a button is a labelable element) but not an accessible name —
  that has to come from `aria-label`, which is why `label` is a string rather
  than a snippet.
-->
<label class="flex items-center gap-2 {className}" {title}>
	<Checkbox {checked} {disabled} aria-label={label} {onCheckedChange} />
	{label}
</label>
