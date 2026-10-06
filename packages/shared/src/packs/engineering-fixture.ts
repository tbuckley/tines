/**
 * Test fixture: the spec's example "engineering" pack
 * (specs/packs/MVP_SPEC.md, "Folder layout" and "File formats"), as text.
 * Used by the packs tests only; not exported from the package.
 */
export function engineeringPack(): Record<string, string> {
	return {
		'pack.yaml': `format: 1
id: tbuckley/engineering
name: Engineering
version: 4
description: Implement, review and ship changes, with QA filing bugs.
derived_from: { id: acme/engineering, version: 2 }

inputs:
  staging_url:
    type: text
    description: Base URL of the staging environment
    default: https://staging.example.com
  reviewer:
    type: text
    description: Who reviews
    required: false
  github_token:
    type: secret
    description: A GitHub token with repo scope
  app_repo:
    type: repo
    description: The application the agents work on
    default_branch: main
  bugs:
    type: workflow
    description: Where QA files the bugs it finds
    default: engineering/triage
  escalation:
    type: workflow
    description: Where agents send questions that need a human
`,
		'README.md': '# Engineering\n\nImplement, review and ship.\n',
		'CHANGELOG.md': '## 4\n\n- Added QA.\n',
		'migrations.yaml': `"4":
  renamed:
    engineering/impl: engineering/implement
  removed:
    engineering/qa-check: engineering/review
"3":
  renamed:
    eng: engineering
`,
		'project/conventions.md': `---
order: 10
description: How we write commit messages
---
Write commit subjects in the imperative mood. Test against
{{ inputs.staging_url }} before handing off.
`,
		'project/skills/escalation/SKILL.md': `---
name: escalation
description: How to escalate
---
Escalate to {{ inputs.escalation }}. Literal: {{! inputs.nope }} and {{ date }}.
`,
		'shared/house-style.md': 'Write plainly. Reviewer: {{inputs.reviewer}}.\n',
		'shared/env.yaml': `LOG_LEVEL: info
API_BASE: "{{ inputs.staging_url }}/api"
GITHUB_TOKEN: { input: github_token }
`,
		'shared/repos.yaml': `app: { input: app_repo, dir: app }
docs: { url: https://github.com/acme/docs, branch: main, dir: docs }
`,
		'shared/skills/pr-hygiene/SKILL.md': `---
name: pr-hygiene
description: Keep pull requests tidy
---
Run scripts/check.sh before opening a PR.
`,
		'shared/skills/pr-hygiene/scripts/check.sh':
			'#!/bin/sh\necho "{{ inputs.not_a_placeholder_here }}"\n',
		'workflows/engineering/workflow.yaml': `name: Engineering
description: From triage to merged.
initial: triage
states:
  triage:
    name: Triage
    category: backlog
    transitions:
      Start: implement
  implement:
    name: Implement
    category: active
    run_scope: issue
    transitions:
      Ready for review: { to: review, requires: [pull-request] }
      Blocked: triage
  review:
    name: Human review
    category: awaiting_human
    transitions:
      Request changes: implement
      Approve: done
  done:
    name: Done
    category: done
`,
		'workflows/engineering/overview.md': 'The engineering workflow.\n',
		'workflows/engineering/states/implement/instructions.md': `---
description: Implement the change
---
Implement it. File bugs in {{ inputs.bugs }}.
`,
		'workflows/engineering/states/implement/skills/tdd/SKILL.md': `---
name: tdd
description: Test first
---
Write the test first.
`,
		'workflows/engineering/states/review/instructions.md': 'Review carefully.\n',
		'workflows/qa/workflow.yaml': `name: QA
initial: test
states:
  test:
    name: Test
    category: active
    run_scope: organization
    transitions:
      Pass: passed
      Fail:
        to: failed
        requires:
          - test-report
          - { artifact: screenshots, type: file, content_type: image/, description: What it looked like }
  passed:
    name: Passed
    category: done
  failed:
    name: Failed
    category: done
`,
		'workflows/qa/states/test/instructions.md': 'Test against {{ inputs.staging_url }}.\n',
		'schedules/weekly-triage.yaml': `name: Weekly triage
workflow: engineering
start: triage
recurrence: { every: weekly, on: mon, at: "09:00" }
only_when_previous_closed: true
title: "Triage for {{ date }}"
description: |
  Sweep new bugs and assign priorities. Escalate anything unclear:
  {{ inputs.escalation }}
`,
		'schedules/nightly.yaml': `name: Nightly QA
workflow: qa
recurrence: { cron: "0 2 * * *" }
title: Nightly QA
`
	};
}
