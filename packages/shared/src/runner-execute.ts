import type { AppendRunLogRequest, FinishRunRequest } from './types.js';

/** One line emitted by a single tines runner execute process. */
export type RunnerExecutionEvent =
	| { type: 'workspace'; workspace_path: string }
	| { type: 'started'; pid: number; started_at: number }
	| { type: 'log'; body: AppendRunLogRequest }
	| { type: 'finish'; body: FinishRunRequest }
	| { type: 'raw_log'; data: string }
	| { type: 'canceled'; workspace_path: string };
