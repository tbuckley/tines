<svelte:head
	><title>Public workflow content rules · Tines</title><meta
		name="robots"
		content="noindex"
	/></svelte:head
>

<main class="mx-auto min-h-screen max-w-3xl px-4 py-10 sm:px-6">
	<a class="text-primary underline" href="/">Tines</a>
	<h1 class="mt-5 text-3xl font-semibold">Public workflow content rules</h1>
	<p class="text-muted-foreground mt-3">
		Public workflows are immutable, inspectable snapshots shared by their publishers. These rules
		support reactive human moderation; publication is not a safety certification.
	</p>

	<section class="mt-8 space-y-3" aria-labelledby="not-allowed">
		<h2 id="not-allowed" class="text-xl font-semibold">What is not allowed</h2>
		<p>
			Do not publish workflows that facilitate abuse, exploitation or threats; expose private data;
			contain malicious or exfiltration instructions; enable phishing; create spam; or infringe
			another person’s rights.
		</p>
		<p>
			Moderators judge context and impact. Tines does not use keyword censorship or automatically
			remove a workflow because it receives many reports.
		</p>
	</section>

	<section class="mt-8 space-y-3" aria-labelledby="reporting">
		<h2 id="reporting" class="text-xl font-semibold">Reporting and decisions</h2>
		<p>
			Anyone can privately report an available workflow. The publisher cannot see report text,
			counts, receipts, or reporter identity. A host moderator can dismiss a report, disable an
			exact snapshot, restore a host removal, suspend a publisher, or unsuspend publishing. Every
			decision records its actor, time, exact target, action, and reason.
		</p>
		<p>
			Reports never hide content automatically. Disable and suspension are immediate for new hosted
			page, download, and installation authority checks. Unavailable pages do not disclose removed
			content or the removal reason.
		</p>
	</section>

	<section class="mt-8 space-y-3" aria-labelledby="retention">
		<h2 id="retention" class="text-xl font-semibold">Privacy and retention</h2>
		<p>
			Rate-limit and retry pseudonyms are kept for two hours. Unresolved report content is kept
			until a human decision; resolved report content is kept for 90 days. Private decision audit is
			kept for one year. An active removal or suspension reason remains while that restriction is
			active.
		</p>
	</section>

	<section class="mt-8 space-y-3" aria-labelledby="appeals">
		<h2 id="appeals" class="text-xl font-semibold">Appeals and distributed copies</h2>
		<p>
			Publishers can use the appeal contact shown in their snapshot management page. An appeal does
			not restore content automatically. Restoring a host removal does not override an owner
			withdrawal or publisher suspension.
		</p>
		<p>
			Moderation cannot recall a workflow that somebody already downloaded or installed as an
			independent private copy.
		</p>
	</section>
</main>
