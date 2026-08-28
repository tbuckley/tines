<script lang="ts">
	/**
	 * Step-by-step instructions for minting the fine-grained GitHub PAT the
	 * managed runners use, shown wherever the PAT can be entered (supervisor
	 * settings and the managed add-runner wizard). Collapsed by default —
	 * users who have done this before just paste the token.
	 */
	let { repoUrls = [] }: { repoUrls?: string[] } = $props();

	/** "https://github.com/o/r(.git)" → "o/r" for compact display. */
	function repoLabel(url: string): string {
		const match = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
		return match ? match[1] : url;
	}
</script>

<details class="text-muted-foreground text-xs">
	<summary class="cursor-pointer font-medium select-none">How to create the token</summary>
	<ol class="mt-1.5 list-decimal space-y-1 pl-4">
		<li>
			On GitHub, open
			<a
				href="https://github.com/settings/personal-access-tokens/new"
				target="_blank"
				rel="noreferrer"
				class="underline underline-offset-2"
			>
				Settings → Developer settings → Fine-grained tokens → Generate new token ↗
			</a>
		</li>
		<li>
			<span class="font-medium">Resource owner:</span> the account or organization that owns your
			repos (an org may require token approval per its policy).
		</li>
		<li>
			<span class="font-medium">Repository access:</span> “Only select repositories” — pick exactly
			{#if repoUrls.length > 0}
				the repos your context items point at:
				<span class="font-mono">{repoUrls.map(repoLabel).join(', ')}</span>.
			{:else}
				the repos your context items point at (none configured yet — you can create the token when
				you add your first repo context item).
			{/if}
		</li>
		<li>
			<span class="font-medium">Permissions → Repository permissions:</span> set
			<span class="font-medium">Contents</span> to “Read and write” so agents can clone and push
			(Metadata: read-only is added automatically). Nothing else is needed.
		</li>
		<li>
			Set an expiration you'll actually rotate on, generate, and copy the
			<span class="font-mono">github_pat_…</span> value — GitHub shows it once. Paste it here.
		</li>
	</ol>
</details>
