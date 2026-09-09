import type { AllowedTransition, Round } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import {
	artifactContentUrl,
	displayStages,
	latestScreenshots,
	screenshotPaths,
	splitBrief,
	transitionMeanings
} from './handoff';

describe('handoff presentation helpers', () => {
	it('keeps headings with the first paragraph and folds the remainder', () => {
		expect(
			splitBrief('# Review\r\n\r\nPlease check the result.\r\n\r\n- Approve: ship it')
		).toEqual({
			lead: '# Review\n\nPlease check the result.',
			rest: '- Approve: ship it'
		});
		expect(splitBrief('One paragraph.')).toEqual({ lead: 'One paragraph.', rest: '' });
	});

	it('matches formatted action bullets, prefers the longest name, and ignores code', () => {
		const transitions = [
			{ transition_id: 'a', name: 'Approve' },
			{ transition_id: 'b', name: 'Approve now' }
		] as AllowedTransition[];
		const meanings = transitionMeanings(
			[
				{
					body: '```\n- Approve: hidden\n```\n- **approve now** — merge the work\n- Approve later is not an action'
				}
			],
			transitions
		);
		expect(meanings).toEqual({ b: 'approve now — merge the work' });
	});

	it('matches the arrow and connector wording used by awaiting-human workflow prompts', () => {
		const transitions = [
			{ transition_id: 'approve', name: 'Approve' },
			{ transition_id: 'implementation', name: 'Send back to Implementation' },
			{ transition_id: 'design', name: 'Send back to Design' },
			{ transition_id: 'research', name: 'Send back to Research' },
			{ transition_id: 'cancel', name: 'Cancel' }
		] as AllowedTransition[];
		expect(
			transitionMeanings(
				[
					{
						body: [
							'- **Approve** → Merging: the work is ready.',
							'- **Send back to Implementation** for code changes.',
							'- **Send back to Design** for a revised plan.',
							'- **Send back to Research** to investigate further.',
							'- **Cancel** if the work should stop.',
							'- Approve later is not an action.'
						].join('\n')
					}
				],
				transitions
			)
		).toEqual({
			approve: 'Approve → Merging: the work is ready.',
			implementation: 'Send back to Implementation for code changes.',
			design: 'Send back to Design for a revised plan.',
			research: 'Send back to Research to investigate further.',
			cancel: 'Cancel if the work should stop.'
		});
	});

	it('shows later workflow positions first and deleted stages last', () => {
		const round = {
			stages: [
				{ state: { id: 'i', name: 'Implementation', position: 3 }, runs: [] },
				{ state: { id: 'gone', name: null, position: null }, runs: [] },
				{ state: { id: 'r', name: 'Review', position: 4 }, runs: [] }
			]
		} as unknown as Round;
		expect(displayStages(round).map((stage) => stage.state.id)).toEqual(['r', 'i', 'gone']);
	});

	it('takes the highest screenshots version and keeps three complete pairs', () => {
		const change = (version: number, files: string[]) => ({
			name: 'screenshots',
			artifact_type: 'folder' as const,
			from_version: null,
			to_version: version,
			pr_url: null,
			files
		});
		const high = change(2, [
			'c-mobile.png',
			'a-mobile.png',
			'b-desktop.png',
			'a-desktop.png',
			'notes.txt',
			'c-desktop.png',
			'b-mobile.png',
			'extra.webp'
		]);
		const round = {
			stages: [
				{ runs: [{ artifacts: [high] }] },
				{ runs: [{ artifacts: [change(1, ['old.png'])] }] }
			]
		} as unknown as Round;
		expect(latestScreenshots(round)).toBe(high);
		expect(screenshotPaths(high)).toEqual([
			'a-desktop.png',
			'a-mobile.png',
			'b-desktop.png',
			'b-mobile.png',
			'c-desktop.png',
			'c-mobile.png'
		]);
		expect(artifactContentUrl('issue 1', 'shots/x', 2, 'a b.png')).toContain(
			'/shots%2Fx/content?version=2&path=a+b.png&inline=1'
		);
	});
});
