import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { EffortCapabilitiesV1, RunnerAssignment } from '@tines/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
	assignmentEffortRejection,
	claudeEffortVersionSupported,
	discoverEffortCapabilities,
	EFFORT_CAPABILITIES_TTL_MS,
	EffortCapabilityRefresher
} from './effort-capabilities.js';

const capabilities: EffortCapabilitiesV1 = {
	version: 1,
	daemon_version: '0.0.194',
	harness: 'codex',
	harness_version: '0.153.4',
	catalog_digest: 'catalog-a',
	models: [{ model: 'gpt-5.6', efforts: ['low', 'high'] }]
};

function assignment(value = 'low', digest = 'catalog-a'): RunnerAssignment {
	return {
		run: { id: 'arun_1', model: 'gpt-5.6' },
		effort: {
			version: 1,
			value,
			capability_digest: digest,
			source: { kind: 'runner_tier', runner_id: 'rnr_1', tier: 'balanced' }
		}
	} as unknown as RunnerAssignment;
}

describe('assignmentEffortRejection', () => {
	it('accepts only the delivered catalog, exact model, value and harness', () => {
		expect(assignmentEffortRejection(assignment(), capabilities, 'codex')).toBeNull();
		expect(assignmentEffortRejection(assignment('ultra'), capabilities, 'codex')).toContain(
			'does not support'
		);
		expect(
			assignmentEffortRejection(assignment('low', 'catalog-b'), capabilities, 'codex')
		).toContain('catalog changed');
		expect(assignmentEffortRejection(assignment(), capabilities, 'claude_code')).toContain(
			'this daemon runs claude_code'
		);
		expect(assignmentEffortRejection(assignment(), undefined, 'codex')).toContain('requires');
	});

	it('preserves old assignments without an effort block', () => {
		const old = { run: { id: 'arun_old' } } as unknown as RunnerAssignment;
		expect(assignmentEffortRejection(old, undefined, 'custom')).toBeNull();
	});
});

describe('capability refresh', () => {
	it('enforces the researched Claude minimum version', () => {
		expect(claudeEffortVersionSupported('2.1.257 (Claude Code)')).toBe(false);
		expect(claudeEffortVersionSupported('2.1.258 (Claude Code)')).toBe(true);
		expect(claudeEffortVersionSupported('2.2.0')).toBe(true);
		expect(claudeEffortVersionSupported('unknown')).toBe(false);
	});

	it('caches within the TTL, coalesces refreshes, and supports a launch reprobe', async () => {
		let now = 1;
		let calls = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const discover = async () => {
			calls++;
			if (calls === 1) await gate;
			return capabilities;
		};
		const refresher = new EffortCapabilityRefresher('codex', 'test', discover, () => now);
		const a = refresher.get();
		const b = refresher.get();
		release();
		await Promise.all([a, b]);
		expect(calls).toBe(1);
		await refresher.get();
		expect(calls).toBe(1);
		await refresher.get(true);
		expect(calls).toBe(2);
		now += EFFORT_CAPABILITIES_TTL_MS + 1;
		await refresher.get();
		expect(calls).toBe(3);
	});
});

describe('Codex discovery against a broken app-server', () => {
	let dir: string | null = null;
	const originalPath = process.env.PATH;

	/** A `codex` on PATH whose `--version` answers but whose `app-server` runs `body`. */
	function fakeCodex(body: string): void {
		dir = mkdtempSync(join(tmpdir(), 'tines-codex-probe-'));
		const bin = join(dir, 'bin');
		mkdirSync(bin);
		writeFileSync(
			join(bin, 'codex'),
			`#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.153.4"; exit 0; fi\n${body}\n`,
			{ mode: 0o755 }
		);
		process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
	}

	afterEach(() => {
		process.env.PATH = originalPath;
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = null;
	});

	it('survives an app-server that closes stdin before the handshake is written', async () => {
		// The fake closes its stdin, then answers the initialize request, then
		// lingers: the daemon's follow-up writes (initialized, model/list) land
		// on a closed pipe and EPIPE deterministically. That is the shape of a
		// Codex that stops reading before the handshake completes — on a loaded
		// machine the daemon used to lose that race by crashing on the
		// unhandled stream error, taking every in-flight run with it.
		fakeCodex('exec 0<&-\necho \'{"id":1,"result":{}}\'\nsleep 3');
		const started = Date.now();
		const report = await discoverEffortCapabilities('codex', 'test');
		expect(Date.now() - started).toBeLessThan(2500);
		expect(report).toMatchObject({ harness: 'codex', models: [] });
		expect(report && 'discovery_error' in report ? report.discovery_error : '').toContain(
			'Codex app-server stdin: write EPIPE'
		);
	});

	it('reports an app-server that exits without answering, without waiting out the deadline', async () => {
		fakeCodex('exit 3');
		const started = Date.now();
		const report = await discoverEffortCapabilities('codex', 'test');
		expect(Date.now() - started).toBeLessThan(4000);
		expect(report && 'discovery_error' in report ? report.discovery_error : '').toContain(
			'exited (code 3) before listing models'
		);
	});
});
