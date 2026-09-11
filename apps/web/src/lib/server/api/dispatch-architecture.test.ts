import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function filesBelow(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? filesBelow(path) : [path];
	});
}

describe('dispatch trigger ownership', () => {
	it('keeps scheduling out of API route handlers and issue transfer', () => {
		const routes = new URL('../../../routes/api/v1', import.meta.url).pathname;
		const sources = filesBelow(routes)
			.filter((path) => path.endsWith('+server.ts'))
			.map((path) => `${path}\n${readFileSync(path, 'utf8')}`)
			.concat(readFileSync(new URL('./issue-transfer.ts', import.meta.url), 'utf8'))
			.join('\n');
		expect(sources).not.toMatch(/supervisor\/engine/);
		expect(sources).not.toMatch(/\b(?:queue|run)DispatchPass\b/);
	});

	it.each([
		['issues.ts', 'createIssue'],
		['issues.ts', 'updateIssue'],
		['issues.ts', 'transitionIssue'],
		['issues.ts', 'resumeIssue'],
		['issue-links.ts', 'addIssueLink'],
		['issue-links.ts', 'removeIssueLink'],
		['labels.ts', 'deleteLabel'],
		['labels.ts', 'addIssueLabels'],
		['labels.ts', 'removeIssueLabel'],
		['routing.ts', 'createRoutingRule'],
		['routing.ts', 'updateRoutingRule'],
		['routing.ts', 'deleteRoutingRule'],
		['runners.ts', 'createRunner'],
		['runners.ts', 'updateRunner'],
		['runners.ts', 'registerRunner'],
		['runners.ts', 'deleteRunner'],
		['supervisor.ts', 'updateSupervisorSettings'],
		['runner-protocol.ts', 'pollRunner'],
		['runner-protocol.ts', 'finishRun'],
		['runs.ts', 'cancelRunForRequest'],
		['schedules.ts', 'runScheduleNow'],
		['projects.ts', 'unarchiveProject'],
		['issue-transfer.ts', 'commitIssueTransfer'],
		['workflows.ts', 'updateWorkflow']
	])('%s %s requires and consumes the dispatch capability', (file, name) => {
		const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
		const start = source.indexOf(`export async function ${name}(`);
		expect(start).toBeGreaterThanOrEqual(0);
		const nextExport = source.indexOf('\nexport ', start + 1);
		const body = source.slice(start, nextExport < 0 ? undefined : nextExport);
		expect(body).toMatch(/(?:actor|runner): ActorContext|runner: RunnerRow/);
		expect(body).toMatch(/effects: DispatchEffects/);
		expect(body).not.toMatch(/effects\?: DispatchEffects|effects\?\./);
		expect(body).toMatch(/effects\.signalDispatch\(\)/);
	});
});
