<script lang="ts">
	import { onMount } from 'svelte';
	import MarketingSignIn from './MarketingSignIn.svelte';
	import './marketing.css';
	import type { OfficeController } from '$lib/marketing/office-scene';
	import { officePhase } from '$lib/marketing/office-layout';

	let { linkError = null }: { linkError?: string | null } = $props();
	let rootEl: HTMLElement;
	let signIn: MarketingSignIn;
	let controller: OfficeController | null = null;
	let paused = $state(false);
	let failed = $state(false);
	let phase = $state(0);
	let progress = $state(0);
	let recoveryDismissed = $state(false);
	const recoveryVisible = $derived(Boolean(linkError) && !recoveryDismissed);

	const phaseNames = [
		'Implementation',
		'Review failed',
		'Implementation continued',
		'Human Review',
		'Closed'
	];
	const phaseNodes = ['implementation', 'review', 'implementation', 'human', 'closed'];
	const phaseNotes = [
		[
			'#13 · Implementation',
			'One desk · one accountable agent',
			'research-findings → design-doc → impl-pr #64'
		],
		[
			'#13 · Review failed',
			'Automated Review → Implementation',
			'“Automated review failed” · Missing regression tests and a branch conflict. See review-notes v2.'
		],
		[
			'#13 · Implementation continued',
			'Implementation → Automated Review',
			'“Submit for automated review” · Both findings fixed. Review-notes v3: 796 tests passed.'
		],
		[
			'#13 · Human Review',
			'Automated Review → Human Review',
			'Waiting for Tom. Only his recorded “Approve” advances the issue to Merging.'
		],
		['#13 · Closed', 'Mailbox → Office → Artifacts out', 'QA, docs and ideation share one tracker.']
	];
	const recordStage = $derived(
		phase === 1
			? 'REVIEW FAILED'
			: phase === 2
				? 'CONTINUED'
				: phase === 3
					? 'HUMAN REVIEW'
					: 'V2 → V3'
	);

	function fallbackFrame() {
		const apertures = [...rootEl.querySelectorAll<HTMLElement>('.aperture')].map((element) => {
			const rect = element.getBoundingClientRect();
			return {
				top: rect.top + scrollY,
				height: rect.height,
				left: rect.left,
				width: rect.width,
				center: rect.top + scrollY + rect.height / 2
			};
		});
		if (apertures.length !== 3) return;
		const next = officePhase({
			width: innerWidth,
			height: innerHeight,
			scrollY,
			end: document.documentElement.scrollHeight - innerHeight,
			apertures: apertures as [(typeof apertures)[0], (typeof apertures)[0], (typeof apertures)[0]]
		});
		phase = next.phase;
		progress = next.progress;
		const scope = phase === 0 ? 'task' : phase === 4 ? 'office' : 'team';
		const still = rootEl.querySelector<HTMLImageElement>('#still');
		if (still)
			still.src = `/marketing/office-v1/${innerWidth < 650 ? 'phone' : 'desktop'}-${scope}-${phase}.png`;
	}

	function openSignIn(event: MouseEvent) {
		signIn.open(event.currentTarget as HTMLElement);
	}

	onMount(() => {
		let disposed = false;
		let fallbackActive = true;
		const updateFallback = () => fallbackActive && fallbackFrame();
		updateFallback();
		window.addEventListener('scroll', updateFallback, { passive: true });
		window.addEventListener('resize', updateFallback);
		void import('$lib/marketing/office-scene')
			.then(({ createOfficeScene }) => {
				if (disposed) return;
				fallbackActive = false;
				window.removeEventListener('scroll', updateFallback);
				window.removeEventListener('resize', updateFallback);
				controller = createOfficeScene({
					rootEl,
					onFrame: (frame) => {
						phase = frame.phase;
						progress = frame.progress;
					},
					onMotionChange: (motion) => {
						paused = motion.paused;
						failed = motion.failed;
					}
				});
			})
			.catch(() => {
				failed = true;
				paused = true;
			});
		return () => {
			disposed = true;
			window.removeEventListener('scroll', updateFallback);
			window.removeEventListener('resize', updateFallback);
			controller?.destroy();
			controller = null;
		};
	});
</script>

<div
	class="marketing-page"
	bind:this={rootEl}
	data-phase={phaseNames[phase]}
	data-progress={progress.toFixed(2)}
>
	{#if recoveryVisible}<p class="recovery" role="alert">{linkError}</p>{/if}
	<div id="stage" aria-hidden="true">
		<img id="still" src="/marketing/office-v1/phone-task-0.png" alt="" />
		<div id="token-label">#13</div>
		<div id="intake-label" hidden>Filed work ↓</div>
		<div id="output-label" hidden>Artifacts ↗</div>
	</div>
	<aside id="scene-note">
		<b>{phaseNotes[phase][0]}</b>
		<div class="mini-route">
			{phase === 0 && progress > 0.05 ? 'One issue · a team taking shape' : phaseNotes[phase][1]}
		</div>
		<p>{phaseNotes[phase][2]}</p>
	</aside>
	<header id="top">
		<nav>
			<a href="#top" class="brand" aria-label="Tines home"
				><svg viewBox="0 0 24 28" aria-hidden="true"
					><path d="M12 26V13L3 8V2M12 13V2M12 13l9-5V2" /></svg
				>Tines</a
			><button onclick={openSignIn}>Sign in ↗</button>
		</nav>
		<div class="opening">
			<p class="eyebrow">HUMANS & AGENTS, ON THE SAME PAGE</p>
			<h1>Manage a system.<br />Let work move.</h1>
			<p class="pitch">
				An issue tracker that gives your agents<br class="desktop" /> a workflow, and you the whole story.
			</p>
		</div>
	</header>
	<main>
		<article id="task" class="chapter">
			<div class="claim band">
				<div class="wrap">
					<p class="eyebrow">THE TASK</p>
					<h2>Give the work<br />a place to start.</h2>
					<p>Assign an issue. Connect a runner.<br />Routing sends eligible work to your runner.</p>
				</div>
			</div>
			<div class="aperture" data-scope="0"></div>
			<section class="record band">
				<div class="wrap">
					<div class="record-head"><b>TINES / 13</b><span>RECORDED EXAMPLE</span></div>
					<h3>Read the whole issue list.</h3>
					<p>
						An Ideation agent found a blind spot. Research confirmed that scans returned <b
							>50 of 74 issues.</b
						>
					</p>
					<div class="run">
						<span class="status-dot"></span><b>macbook-claude</b><span>Research complete →</span>
					</div>
					<p class="artifacts">
						research-findings <span>→</span> design-doc <span>→</span> impl-pr · #64
					</p>
				</div>
			</section>
		</article>
		<article id="team" class="chapter">
			<div class="claim band">
				<div class="wrap">
					<p class="eyebrow">THE WORKFLOW</p>
					<h2>A handoff.<br />Then a way back.</h2>
					<p>
						Agents implement and review. Steer with comments and transitions; the next run picks up
						the record.
					</p>
				</div>
			</div>
			<div class="aperture" data-scope="1"></div>
			<section class="record band">
				<div class="wrap">
					<div class="record-head">
						<b>#13 / REVIEW & CONTINUATION</b><span>{recordStage}</span>
					</div>
					<div class="review-pair">
						<div>
							<h3>Review failed ↶</h3>
							<p>
								Missing regression tests. A branch conflict. <b>review-notes v2</b> sent the work back
								to Implementation.
							</p>
						</div>
						<div>
							<h3>The next run continued.</h3>
							<p>
								Both findings fixed. Independent review: <b>796 tests passed.</b> Human Review waited
								for Tom.
							</p>
						</div>
					</div>
					<div class="graph" aria-label="Engineering workflow">
						<span>Backlog</span><i>→</i><span>Research</span><i>→</i><span>Design</span><i>→</i
						><span data-node="implementation" class:active={phaseNodes[phase] === 'implementation'}
							>Implementation</span
						><i>→</i><span data-node="review" class:active={phaseNodes[phase] === 'review'}
							>Automated Review</span
						><i>→</i><span data-node="human" class:active={phaseNodes[phase] === 'human'}
							>Human Review</span
						><i>→</i><span>Merging</span><i>→</i><span
							data-node="closed"
							class:active={phaseNodes[phase] === 'closed'}>Closed</span
						>
					</div>
					<div class="return-edge">Automated review failed <span>↶ Implementation</span></div>
					<p class="small">
						“Automated review passed” → Human Review. Tom’s recorded “Approve” → Merging. “Merged” →
						Closed.
					</p>
				</div>
			</section>
		</article>
		<section class="controls band">
			<div class="wrap">
				<div>
					<p class="eyebrow">YOUR AGENTS. YOUR CONTROLS.</p>
					<h2>Your runners.<br />Your controls.</h2>
				</div>
				<div class="control-copy">
					<p>
						Automation starts enabled. Routing decides where work goes; pause automation when you
						need to stop dispatch.
					</p>
					<p>
						<b>Managed:</b> your own Anthropic key.<br /><b>Local:</b> your machine, subscription and
						git credentials. Runners include macbook-claude and macbook-codex.
					</p>
					<p>
						<b>Web</b> to review. <b>CLI</b> from your terminal.<br /><b>API</b> to connect your agents.
					</p>
					<p class="small">
						Beyond code: a family-trip agent can compare trains, attach options and wait for your
						preference.
					</p>
				</div>
			</div>
		</section>
		<article id="office" class="chapter">
			<div class="claim band">
				<div class="wrap">
					<p class="eyebrow">THE SYSTEM</p>
					<h2>Good work makes<br />the next work better.</h2>
					<p>
						Schedule QA, docs and ideation. Agents file issues for one another—and improvements to
						their instructions.
					</p>
				</div>
			</div>
			<div class="aperture" data-scope="2"></div>
			<section class="record band final-record">
				<div class="wrap">
					<div class="office-legend">
						<span>Illustrative traffic · recorded history</span><button
							id="motion"
							aria-pressed={paused || failed}
							disabled={failed}
							onclick={() => controller?.toggleMotion()}
							>{failed ? 'Still office' : paused ? 'Resume motion' : 'Pause motion'}</button
						>
					</div>
					<div class="record-head"><b>#13 CLOSED · PR #64 MERGED</b><span>48eb053</span></div>
					<div class="followups">
						<p><b>#75 → Ideating v6</b><br />Tom accepted complete-scan instructions.</p>
						<p><b>#77 → Auditing v3</b><br />The same lesson improved Docs Audit.</p>
					</div>
					<p class="small">
						Separate agent-filed proposals. The original stays Closed. Mailbox: new work in.
						Airplanes: completed artifacts out. Traffic does not approve work.
					</p>
					<footer>
						<div><b class="brand">Tines</b><span>Make room for your next task.</span></div>
						<div>
							<button onclick={openSignIn}>Sign in ↗</button><small>Google or a magic link</small>
						</div>
					</footer>
				</div>
			</section>
		</article>
	</main>
	<MarketingSignIn bind:this={signIn} {linkError} onOpened={() => (recoveryDismissed = true)} />
</div>
