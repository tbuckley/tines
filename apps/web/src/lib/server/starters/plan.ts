import type { Starter } from './types';

const scouting = `Read the current Scout issue, its full brief, conventions, comments, and the project planning-guide. Unanswered convention lines are unspecified; the current issue brief controls later scouting tasks. List every existing idea in the project, across all pages and including passed/done ideas, and read relevant proposals and feedback so you do not duplicate or repeat a rejected idea without a new reason.

Research 4–6 worthwhile candidates against the known constraints. Use web search when available and cite supporting links. Never invent addresses, hours, prices, accessibility, or availability: identify unverified details and research limits. Fewer or no candidates is correct when fewer qualify; never pad the count.

For each candidate, write a phone-length description (roughly 2–4 short sentences) and a Markdown proposal with What, Why it fits, When it works, Practical details, and Uncertainties. Cover known location/travel, booking, cost, and family constraints with sources. Create the idea in New, attach proposal.md, then use the gated Propose transition and verify the resulting issue. Repair partial failures instead of making duplicates.

Finish with one “Scouting result” comment linking filed candidates and explaining the search, exclusions, shortfall, and unresolved failures. Use File candidates when at least one was proposed, Nothing to file when none qualify, or Abandon only when the task cannot or should not continue. Do not claim incomplete candidates were filed. The planning-guide contains the actual workflow IDs and executable commands for this project.`;

const reworking = `Read the current proposal and latest human comments. Identify every requested change, re-check affected facts and other ideas as needed, revise the proposal, and align the title and short description. Attach a new proposal version after entering Reworking; do not reaffirm the old artifact. Comment what changed, what could not be changed, and the remaining uncertainties, then use Re-propose. Never approve the idea yourself. The project planning-guide contains executable commands.`;

const planningGuide = `# Planning guide

Follow only the section matching the current issue state. The applied workflow bindings are:

- Project: {{ project_id }}
- Idea role: {{ workflow_idea_name }} ({{ workflow_idea_id }})
- Scout role: {{ workflow_scout_name }} ({{ workflow_scout_id }})

## Scouting

${scouting}

Use returned issue refs for \`<candidate-ref>\` and the current Scout ref for \`<scout-ref>\`; these are placeholders, not literal arguments. Read identity from create's JSON response (no jq required).

\`\`\`sh
tines issues list -p "{{ project_id }}" -w "{{ workflow_idea_id }}" --all --all-pages --json
tines issues create "{{ project_id }}" -w "{{ workflow_idea_id }}" -s New -t "Candidate title" -d @description.md --json
tines issues artifacts attach "<candidate-ref>" proposal --text @proposal.md
tines issues move "<candidate-ref>" "Propose"
tines issues show "<candidate-ref>" --json
tines issues comment "<scout-ref>" @scouting-result.md
tines issues move "<scout-ref>" "File candidates"
\`\`\`

If none qualify, use \`Nothing to file\`; use \`Abandon\` only when the task cannot or should not continue.

## Reworking

${reworking}

\`\`\`sh
tines issues artifacts get "<candidate-ref>" proposal --out .
tines issues edit "<candidate-ref>" -a title -d @description.md
tines issues artifacts attach "<candidate-ref>" proposal --text @proposal.md
tines issues comment "<candidate-ref>" @changes.md
tines issues move "<candidate-ref>" "Re-propose"
\`\`\``;

export const plan: Starter = {
	id: 'plan',
	name: 'Plan something together',
	description: 'Scout trip or family-activity ideas, make proposals, and decide together.',
	inputs: [
		{
			key: 'brief',
			label: 'What are you planning?',
			required: true,
			description:
				'A long weekend with two adults and two children; outdoor options and a rainy-day backup.',
			max: 10_000
		}
	],
	workflows: [
		{
			name: 'Idea',
			description: 'A candidate activity or destination, proposed for a human decision.',
			initial_state: 'New',
			states: [
				{ name: 'New', category: 'backlog' },
				{
					name: 'Proposed',
					category: 'awaiting_human',
					prompt:
						'Read the proposal and supporting links. Choose Approve or Pass, or leave specific feedback and use Send back. This is a human decision stage, not agent work.'
				},
				{ name: 'Reworking', category: 'active', prompt: reworking },
				{ name: 'Approved', category: 'done' },
				{ name: 'Passed', category: 'done' }
			],
			transitions: [
				{
					name: 'Propose',
					from: 'New',
					to: 'Proposed',
					requires: [
						{
							artifact: 'proposal',
							type: 'text',
							content_type: 'text/markdown',
							description: 'What, why it fits, when it works, practical details, and uncertainties'
						}
					]
				},
				{ name: 'Approve', from: 'Proposed', to: 'Approved' },
				{ name: 'Pass', from: 'Proposed', to: 'Passed' },
				{ name: 'Send back', from: 'Proposed', to: 'Reworking' },
				{
					name: 'Re-propose',
					from: 'Reworking',
					to: 'Proposed',
					requires: [
						{
							artifact: 'proposal',
							type: 'text',
							content_type: 'text/markdown',
							description: 'The revised proposal addressing the latest human feedback'
						}
					]
				}
			]
		},
		{
			name: 'Scout',
			description: 'Research worthwhile candidates and file proposals for a human decision.',
			initial_state: 'Backlog',
			states: [
				{ name: 'Backlog', category: 'backlog' },
				{ name: 'Scouting', category: 'active', prompt: scouting },
				{ name: 'Filed', category: 'done' },
				{ name: 'Nothing found', category: 'done' },
				{ name: 'Abandoned', category: 'done' }
			],
			transitions: [
				{ name: 'Start scouting', from: 'Backlog', to: 'Scouting' },
				{ name: 'File candidates', from: 'Scouting', to: 'Filed' },
				{ name: 'Nothing to file', from: 'Scouting', to: 'Nothing found' },
				{ name: 'Abandon', from: 'Scouting', to: 'Abandoned' }
			]
		}
	],
	default_workflow: 'Idea',
	context: [{ kind: 'prompt', name: 'planning-guide', body: planningGuide }],
	conventions_template: `Planning brief: {{ brief }}
Who is going:
Where and when:
Constraints (naps, walking, budget, diet):
What you decide per idea (approve / pass / rework):
What makes a good candidate:

Unanswered lines are unspecified, not defaults. Use the brief and any answers supplied; explain material unknowns rather than inventing preferences.`,
	first_issue: {
		title: 'Scout candidates for {{ brief }}',
		description: `# Planning brief

{{ brief }}

Research 4–6 worthwhile candidates using conventions and the complete planning-guide. Check existing ideas first. File each in {{ workflow_idea_name }} ({{ workflow_idea_id }}) with a phone-length description and sourced Markdown proposal, then leave it Proposed for a human decision. Never invent details; explain uncertainties and file fewer or none when truthful.

Finish this issue in {{ workflow_scout_name }} ({{ workflow_scout_id }}) with one Scouting result comment linking candidates and explaining exclusions or shortfalls. Use File candidates when at least one proposal succeeded, Nothing to file when none qualify, or Abandon only when the task cannot continue.`,
		workflow: 'Scout',
		state: 'Scouting'
	}
};
