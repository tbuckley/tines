import { STARTER_IDS, type StarterId } from '@tines/shared';
import { blank } from './blank';
import { code } from './code';
import { plan } from './plan';
import type { Starter } from './types';

export type { Starter, StarterContextEntry, StarterFirstIssue } from './types';

/** The built-in starters, by id. */
export const STARTERS: Readonly<Record<StarterId, Starter>> = { blank, code, plan };

export { STARTER_IDS };
