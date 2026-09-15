import { randomBytes } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { BASE_URL } from './constants.mjs';
import { apiClient, signIn } from './helpers';

export type SessionIdentity = { sessionToken: string };
export type ApiIdentity = { apiKey: string };
export type ApiClient = ReturnType<typeof apiClient>;
export type UniqueName = (stem: string, options?: { maxLength?: number }) => string;

type TestFixtures = {
	signedIn: SessionIdentity | null;
};

type WorkerFixtures = {
	workerRequest: APIRequestContext;
	apiFor: (account: ApiIdentity) => ApiClient;
	uniqueName: UniqueName;
};

const namespace = randomBytes(12).toString('hex');
let allocation = 0n;

const allocateUniqueName: UniqueName = (stem, options = {}) => {
	const readable = stem.trim();
	if (!readable) throw new Error('uniqueName requires a non-empty stem');

	const maxLength = options.maxLength ?? 50;
	if (!Number.isInteger(maxLength) || maxLength <= 0) {
		throw new Error('uniqueName maxLength must be a positive integer');
	}

	allocation += 1n;
	const suffix = `-${namespace}-${allocation.toString(36)}`;
	const stemLength = maxLength - suffix.length;
	if (stemLength < 1) {
		throw new Error(
			`uniqueName maxLength ${maxLength} is too short; it must leave room for the unique suffix and one stem character`
		);
	}

	return `${readable.slice(0, stemLength)}${suffix}`;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
	signedIn: [null, { option: true }],
	context: async ({ context, signedIn }, use) => {
		if (signedIn) await signIn(context, signedIn.sessionToken);
		await use(context);
	},
	workerRequest: [
		async ({ playwright }, use) => {
			const request = await playwright.request.newContext({
				baseURL: BASE_URL,
				storageState: undefined
			});
			try {
				await use(request);
			} finally {
				await request.dispose();
			}
		},
		{ scope: 'worker' }
	],
	apiFor: [
		async ({ workerRequest }, use) => {
			await use((account) => apiClient(workerRequest, account.apiKey));
		},
		{ scope: 'worker' }
	],
	uniqueName: [
		async ({}, use) => {
			await use(allocateUniqueName);
		},
		{ scope: 'worker' }
	]
});

export { expect };
