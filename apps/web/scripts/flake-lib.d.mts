export interface FlakeFailure {
	file: string;
	line: number;
	title: string;
	error: string;
	status?: string;
}

export interface FlakeObservation extends FlakeFailure {
	runId: number;
	attempt: number;
	sha: string;
	branch: string;
	createdAt: string;
}

export interface LedgerRow {
	key: string;
	file: string;
	line: number;
	title: string;
	error: string;
	redRuns: number;
	runs: string[];
	branches: string[];
	lastSeen: string;
	reasons: string[];
	flaky: boolean;
	issue: string | null;
}

export type KnownFlakes = Record<string, string>;

export const BRANCH_THRESHOLD: number;
export function flakeKey(test: Pick<FlakeFailure, 'file' | 'line' | 'title'>): string;
export function parseListLog(text: string): FlakeFailure[];
export function parseJsonReport(report: unknown): FlakeFailure[];
export function knownIssue(
	known: KnownFlakes,
	failure: Pick<FlakeFailure, 'file' | 'line' | 'title'>
): string | null;
export function buildLedger(
	observations: FlakeObservation[],
	greenShas: Set<string>,
	known?: KnownFlakes,
	mainBranch?: string
): LedgerRow[];
export function renderLedger(rows: LedgerRow[], options: { days: number }): string;
export function renderSummary(failures: FlakeFailure[], known: KnownFlakes): string;
