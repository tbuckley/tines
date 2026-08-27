/**
 * The fake adapter: a configurable, recording RunnerAdapter for unit tests.
 * `launchMode: 'immediate'` so the engine drives the full claim → launching
 * → running path against it. Not imported by production code.
 */
import type {
	AdapterLaunchInput,
	AdapterLaunchResult,
	AdapterPollResult,
	AdapterRunRef,
	RunnerAdapter
} from './adapter';

export interface FakeAdapter extends RunnerAdapter {
	launches: AdapterLaunchInput[];
	cancels: AdapterRunRef[];
	polls: AdapterRunRef[];
	/** Queue a launch failure (consumed in order before default success). */
	failNextLaunch(error: Error | string): void;
	/** Session id for the next successful launch (default `fake-session-N`). */
	nextSessionId(id: string): void;
	/** Queue a poll result (consumed in order; empty queue polls `{}`). */
	nextPoll(result: AdapterPollResult): void;
}

export function createFakeAdapter(): FakeAdapter {
	const failures: Error[] = [];
	const sessionIds: string[] = [];
	const pollResults: AdapterPollResult[] = [];
	let counter = 0;
	const fake: FakeAdapter = {
		launchMode: 'immediate',
		launches: [],
		cancels: [],
		polls: [],
		failNextLaunch(error) {
			failures.push(typeof error === 'string' ? new Error(error) : error);
		},
		nextSessionId(id) {
			sessionIds.push(id);
		},
		nextPoll(result) {
			pollResults.push(result);
		},
		launch(input: AdapterLaunchInput): Promise<AdapterLaunchResult> {
			fake.launches.push(input);
			const failure = failures.shift();
			if (failure) return Promise.reject(failure);
			const sessionId = sessionIds.shift() ?? `fake-session-${++counter}`;
			return Promise.resolve({
				provider_session_id: sessionId,
				provider_url: `https://provider.example/${sessionId}`
			});
		},
		poll(run: AdapterRunRef): Promise<AdapterPollResult> {
			fake.polls.push(run);
			return Promise.resolve(pollResults.shift() ?? {});
		},
		cancel(run: AdapterRunRef): Promise<void> {
			fake.cancels.push(run);
			return Promise.resolve();
		}
	};
	return fake;
}
