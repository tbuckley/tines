/**
 * Pure helpers for the Gemini adapter's poll loop: interaction steps →
 * run-log lines, interaction usage → `AgentRunUsage` (table-priced). No I/O
 * and nothing bound to `env`, so they are unit-tested directly in
 * `gemini-steps.test.ts` instead of through the adapter's network fake.
 *
 * The request/response shapes are the Interactions API's (v1beta), typed
 * here to the fields this code reads rather than pulled from `@google/genai`
 * — the SDK carries Node-only dependencies (google-auth-library, ws,
 * protobufjs) that have no place in a worker bundle for four REST calls.
 */
import { priceUsage, type AgentRunUsage } from '@tines/shared';

// ---------------------------------------------------------------------------
// The wire shapes we read

export type GeminiInteractionStatus =
	| 'queued'
	| 'in_progress'
	| 'requires_action'
	| 'completed'
	| 'failed'
	| 'cancelled'
	| 'incomplete'
	| 'budget_exceeded'
	| (string & {});

export interface GeminiUsage {
	total_input_tokens?: number;
	total_output_tokens?: number;
	total_thought_tokens?: number;
	total_cached_tokens?: number;
	total_tool_use_tokens?: number;
	total_tokens?: number;
}

export interface GeminiTextContent {
	type: 'text';
	text: string;
}

export type GeminiContent = GeminiTextContent | { type: string; [k: string]: unknown };

/** The step kinds the log renders; anything else is passed over silently. */
export type GeminiStep =
	| { type: 'user_input'; content?: GeminiContent[] }
	| { type: 'model_output'; content?: GeminiContent[]; error?: { code?: number; message?: string } }
	| { type: 'thought'; summary?: GeminiContent[] }
	| { type: 'function_call'; id: string; name: string; arguments: Record<string, unknown> }
	| {
			type: 'function_result';
			call_id: string;
			name?: string;
			is_error?: boolean;
			result: string | GeminiContent[] | Record<string, unknown>;
	  }
	| { type: 'code_execution_call'; id: string; arguments: { code?: string; language?: string } }
	| { type: 'code_execution_result'; call_id: string; is_error?: boolean; result: string }
	| { type: string; [k: string]: unknown };

export interface GeminiInteraction {
	id: string;
	status: GeminiInteractionStatus;
	environment_id?: string;
	model?: string;
	steps?: GeminiStep[];
	usage?: GeminiUsage;
	errors?: { code?: string; message?: string }[];
	output_text?: string;
}

// ---------------------------------------------------------------------------
// Usage

/**
 * The interaction's cumulative usage as a ledger record. Gemini reports
 * tokens only, so dollars come from the pricing table (`cost_source:
 * priced`); a model missing from it records tokens with no cost — the
 * unpriced state the budget milestone will warn about.
 */
export function mapGeminiUsage(
	usage: GeminiUsage | undefined,
	model: string | null
): AgentRunUsage {
	const out: AgentRunUsage = {
		input_tokens: usage?.total_input_tokens ?? 0,
		output_tokens: usage?.total_output_tokens ?? 0,
		cost_source: 'priced'
	};
	if (usage?.total_cached_tokens) out.cache_read_tokens = usage.total_cached_tokens;
	if (usage?.total_thought_tokens) out.thought_tokens = usage.total_thought_tokens;
	const cost = priceUsage(model, out);
	if (cost !== undefined) out.cost_usd = cost;
	return out;
}

// ---------------------------------------------------------------------------
// Steps → log lines

export function textOf(content: GeminiContent[] | undefined): string {
	return (content ?? [])
		.map((block) => (block.type === 'text' ? (block as GeminiTextContent).text : ''))
		.join('')
		.trim();
}

export function clip(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

function resultText(result: unknown): string {
	if (typeof result === 'string') return result;
	if (Array.isArray(result)) return textOf(result as GeminiContent[]);
	return JSON.stringify(result);
}

/** One interaction step → zero or one log lines (the sweep-rendered summary). */
export function renderStep(step: GeminiStep): string | null {
	switch (step.type) {
		case 'user_input':
			return `[user] message delivered (${textOf(step.content as GeminiContent[]).length} chars)`;
		case 'model_output': {
			const error = (step as { error?: { message?: string } }).error;
			if (error?.message) return `[error] ${error.message}`;
			const text = textOf(step.content as GeminiContent[]);
			return text ? `[agent] ${clip(text, 2000)}` : null;
		}
		case 'function_call': {
			const s = step as { name: string; arguments: unknown };
			return `[tool] ${s.name} ${clip(JSON.stringify(s.arguments ?? {}), 300)}`;
		}
		case 'function_result': {
			const s = step as { is_error?: boolean; result: unknown };
			if (!s.is_error) return null;
			return `[tool] error: ${clip(resultText(s.result), 300)}`;
		}
		case 'code_execution_call': {
			const s = step as { arguments?: { code?: string } };
			return `[tool] code ${clip(s.arguments?.code ?? '', 300)}`;
		}
		case 'code_execution_result': {
			const s = step as { is_error?: boolean; result: string };
			if (!s.is_error) return null;
			return `[tool] error: ${clip(s.result ?? '', 300)}`;
		}
		default:
			// Thoughts, processing markers, and step kinds this code predates:
			// nothing the log needs.
			return null;
	}
}

export interface StepSummary {
	lines: string[];
	/** The last error a `model_output` step carried, if any. */
	lastError?: string;
}

/** Folds the steps newer than the cursor into the poll loop's summary. */
export function summarizeSteps(steps: GeminiStep[], seen: number): StepSummary {
	const lines: string[] = [];
	let lastError: string | undefined;
	for (const step of steps.slice(Math.max(0, seen))) {
		const line = renderStep(step);
		if (line) lines.push(line);
		if (step.type === 'model_output') {
			const message = (step as { error?: { message?: string } }).error?.message;
			if (message) lastError = message;
		}
	}
	return { lines, lastError };
}

/**
 * The status line the log gets when the interaction's status changes, and
 * how the run ends for terminal statuses. `null` = still going.
 */
export function judgeInteraction(
	interaction: Pick<GeminiInteraction, 'status' | 'errors'>,
	lastError: string | undefined
): { status: 'completed' | 'failed' | 'canceled'; error: string | null } | null {
	const providerError = interaction.errors?.find((e) => e.message)?.message ?? lastError;
	switch (interaction.status) {
		case 'completed':
			return { status: 'completed', error: null };
		case 'failed':
			return { status: 'failed', error: providerError ?? 'interaction failed' };
		case 'cancelled':
			return { status: 'canceled', error: providerError ?? null };
		case 'incomplete':
			return {
				status: 'failed',
				error: providerError ?? 'interaction ended incomplete (the agent stopped before finishing)'
			};
		case 'budget_exceeded':
			return {
				status: 'failed',
				error: 'per-run token cap reached (interaction stopped at its max_total_tokens budget)'
			};
		case 'requires_action':
			return {
				status: 'failed',
				error: 'interaction paused awaiting a tool result, which supervisor runs never provide'
			};
		default:
			return null;
	}
}
