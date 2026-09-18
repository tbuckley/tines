/**
 * The interactive confirmation for `tines issues transfer`: that inspecting an
 * item is never mistaken for an answer, that anything but "yes" — including no
 * answer at all — aborts, and that the prompt goes nowhere near stdout.
 */
import type { IssueTransferPreview } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import { confirmTransfer, type TransferTerminal } from './issue-transfer.js';

const scope = (label: string) => ({
	project_id: null,
	project_name: null,
	workflow_state_id: null,
	workflow_state_name: null,
	workflow_id: null,
	workflow_name: null,
	label_id: null,
	label_name: null,
	label_color: null,
	issue_id: null,
	issue_ref: null,
	label
});

const empty = {
	prompt: { text: '', parts: [], journal: null },
	skills: [],
	repos: [],
	overridden: [],
	conflicts: []
};

const preview = {
	issue_id: 'iss_1',
	source: { id: 'prj_src', name: 'demo', archived: false },
	destination: { id: 'prj_dst', name: 'platform', archived: false },
	old_ref: { project_id: 'prj_src', project_name: 'demo', number: 4, ref: 'demo/4' },
	new_ref: null,
	number_notice: 'Number assigned when you move.',
	preserved: {
		title: 'Port the importer',
		workflow_id: 'wf_1',
		state_id: 'wfs_1',
		state_entered_at: 0,
		created_at: 0,
		labels: [],
		pinned_runner_id: null,
		pinned_tier: null,
		attempt_count: 0,
		parked: false,
		comment_count: 1,
		artifact_count: 0,
		artifact_version_count: 0,
		run_count: 0,
		link_count: 0
	},
	context: {
		before: empty,
		after: {
			...empty,
			prompt: {
				text: 'Deploy on Fridays.',
				parts: [
					{
						item_id: 'ctx_dest',
						name: 'platform-context',
						scope: scope('project platform'),
						body: 'Deploy on Fridays.',
						version: 1,
						is_journal: false,
						inherited_from: null
					}
				],
				journal: null
			}
		},
		changes: [
			{
				item_id: 'ctx_dest',
				name: 'platform-context',
				kind: 'prompt',
				change: 'added',
				scope_before: null,
				scope_after: scope('project platform'),
				effective_before: false,
				effective_after: true
			}
		]
	},
	routing: { before: null, after: null },
	schedule: null,
	noop: false,
	can_commit: true,
	blockers: [],
	preview_token: 'tok_reviewed',
	previewed_at: 0
} as unknown as IssueTransferPreview;

/** A terminal that gives the listed answers in order, then ends (EOF). */
function terminal(answers: (string | null)[]) {
	const written: string[] = [];
	const asked: string[] = [];
	const io: TransferTerminal = {
		write: (text) => void written.push(text),
		ask: async (question) => {
			asked.push(question);
			return answers.length ? (answers.shift() as string | null) : null;
		}
	};
	return { io, written, asked, out: () => written.join('') };
}

describe('confirmTransfer', () => {
	it('commits only on an explicit yes', async () => {
		for (const answer of ['y', 'Y', 'yes', ' yes ']) {
			const t = terminal([answer]);
			expect(await confirmTransfer(preview, t.io)).toEqual({ action: 'commit' });
		}
	});

	it('aborts on the empty default, on no, and on anything else', async () => {
		for (const answer of ['', 'n', 'no', 'later']) {
			const t = terminal([answer]);
			expect(await confirmTransfer(preview, t.io)).toEqual({ action: 'abort', reason: 'aborted' });
		}
	});

	it('aborts when the input ends without an answer', async () => {
		const t = terminal([null]);
		expect(await confirmTransfer(preview, t.io)).toEqual({ action: 'abort', reason: 'no answer' });
		expect(t.asked).toHaveLength(1);
	});

	it('shows an inspected item and then asks again, so reading is not answering', async () => {
		const t = terminal(['0', 'y']);
		expect(await confirmTransfer(preview, t.io)).toEqual({ action: 'commit' });
		expect(t.out()).toContain('Deploy on Fridays.');
		// Two questions: the item never stood in for the confirmation.
		expect(t.asked).toHaveLength(2);
	});

	it('keeps asking until it gets an answer it can act on', async () => {
		const t = terminal(['0', '0', null]);
		expect(await confirmTransfer(preview, t.io)).toEqual({ action: 'abort', reason: 'no answer' });
		expect(t.asked).toHaveLength(3);
	});

	it('offers the inspectable range and repeats the whole review after a refresh', async () => {
		const t = terminal(['n']);
		await confirmTransfer(preview, t.io, 'The configuration has changed.');
		expect(t.out()).toContain('The configuration has changed.');
		expect(t.out()).toContain('Move demo/4 from demo to platform');
		expect(t.asked[0]).toContain('a number 0-0 to read that item');
	});

	it('drops the inspect hint when there is nothing to read', async () => {
		const bare = {
			...preview,
			context: { ...preview.context, changes: [] }
		} as IssueTransferPreview;
		const t = terminal(['n']);
		await confirmTransfer(bare, t.io);
		expect(t.asked[0]).toBe('Move demo/4 to platform? [y/N] ');
	});
});
