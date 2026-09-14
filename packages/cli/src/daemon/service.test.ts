import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	daemonArgs,
	daemonStartedLine,
	defaultServiceManager,
	findOnPath,
	matchDaemonProcesses,
	renderLaunchdPlist,
	renderSystemdUnit,
	serviceCommands,
	serviceLabel,
	servicePath,
	unitPath,
	type ServiceSpec
} from './service.js';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const spec: ServiceSpec = {
	name: 'macbook-codex',
	kind: 'launchd',
	binary: '/Users/me/.config/tines/cli/node_modules/.bin/tines',
	args: daemonArgs({
		url: 'https://tines.example',
		name: 'macbook-codex',
		harness: 'codex',
		maxConcurrent: 4
	}),
	path: '/opt/homebrew/bin:/usr/bin:/bin',
	logPath: '/Users/me/.config/tines/logs/runner-macbook-codex.log',
	env: {}
};

describe('service identity', () => {
	it('picks the service manager the platform ships', () => {
		expect(defaultServiceManager('darwin')).toBe('launchd');
		expect(defaultServiceManager('linux')).toBe('systemd');
		expect(defaultServiceManager('win32')).toBeNull();
	});

	it('derives label and unit path from the runner name', () => {
		expect(serviceLabel('macbook-codex', 'launchd')).toBe('dev.tines.runner.macbook-codex');
		expect(serviceLabel('macbook-codex', 'systemd')).toBe('tines-runner-macbook-codex');
		expect(unitPath('macbook-codex', 'launchd', '/Users/me')).toBe(
			'/Users/me/Library/LaunchAgents/dev.tines.runner.macbook-codex.plist'
		);
		expect(unitPath('macbook-codex', 'systemd', '/home/me')).toBe(
			'/home/me/.config/systemd/user/tines-runner-macbook-codex.service'
		);
	});
});

describe('daemonArgs', () => {
	it('writes only what differs from the daemon defaults, and never a key', () => {
		expect(
			daemonArgs({
				url: 'https://t.example',
				name: 'box',
				harness: 'claude-code',
				maxConcurrent: 1
			})
		).toEqual([
			'runner',
			'daemon',
			'--url',
			'https://t.example',
			'--name',
			'box',
			'--harness',
			'claude-code'
		]);
		expect(
			daemonArgs({
				url: 'https://t.example',
				name: 'box',
				harness: 'custom',
				command: 'my-agent {prompt_file}',
				maxConcurrent: 3,
				pollIntervalSeconds: 30,
				keepWorkspaces: 'failed',
				keepWorkspacesForHours: 24,
				keepWorkspacesMax: 5
			})
		).toEqual([
			'runner',
			'daemon',
			'--url',
			'https://t.example',
			'--name',
			'box',
			'--harness',
			'custom',
			'--command',
			'my-agent {prompt_file}',
			'--max-concurrent',
			'3',
			'--poll-interval',
			'30',
			'--keep-workspaces',
			'failed',
			'--keep-workspaces-for',
			'24',
			'--keep-workspaces-max',
			'5'
		]);
	});
});

describe('servicePath', () => {
	it("names the node dir, each required executable's dir, then the platform bins, deduplicated", () => {
		const root = mkdtempSync(join(tmpdir(), 'tines-svc-'));
		dirs.push(root);
		const nvm = join(root, 'nvm', 'bin');
		const brew = join(root, 'brew');
		mkdirSync(nvm, { recursive: true });
		mkdirSync(brew, { recursive: true });
		writeFileSync(join(brew, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
		writeFileSync(join(nvm, 'git'), '#!/bin/sh\n', { mode: 0o755 });
		const { path, missing } = servicePath({
			execPath: join(nvm, 'node'),
			required: ['codex', 'git', 'claude'],
			envPath: [brew, nvm].join(':'),
			platform: 'darwin'
		});
		expect(path.split(':')).toEqual([
			nvm,
			brew,
			'/opt/homebrew/bin',
			'/usr/local/bin',
			'/usr/bin',
			'/bin'
		]);
		expect(missing).toEqual(['claude']);
		expect(findOnPath('codex', `${nvm}:${brew}`)).toBe(join(brew, 'codex'));
		expect(findOnPath('nothing', `${nvm}:${brew}`)).toBeNull();
	});
});

describe('unit rendering', () => {
	it('launchd: launches the managed binary, keeps it alive, logs to the file, carries no secret', () => {
		const plist = renderLaunchdPlist({
			...spec,
			env: { TINES_CONFIG_DIR: '/Users/me/cfg' }
		});
		expect(plist).toContain('<key>Label</key><string>dev.tines.runner.macbook-codex</string>');
		expect(plist).toContain('<string>/Users/me/.config/tines/cli/node_modules/.bin/tines</string>');
		expect(plist).toContain('<string>--max-concurrent</string>\n\t\t<string>4</string>');
		expect(plist).toContain('<key>KeepAlive</key><true/>');
		expect(plist).toContain('<key>RunAtLoad</key><true/>');
		expect(plist).toContain('<key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>');
		expect(plist).toContain('<key>TINES_CONFIG_DIR</key><string>/Users/me/cfg</string>');
		expect(plist).toContain(
			'<key>StandardOutPath</key><string>/Users/me/.config/tines/logs/runner-macbook-codex.log</string>'
		);
		expect(plist).not.toMatch(/API_KEY|tines_/);
	});

	it('launchd: escapes XML in a custom command template', () => {
		const plist = renderLaunchdPlist({
			...spec,
			args: daemonArgs({
				url: 'https://t.example',
				name: 'box',
				harness: 'custom',
				command: 'agent <{prompt_file}> && echo "done"',
				maxConcurrent: 1
			})
		});
		expect(plist).toContain(
			'<string>agent &lt;{prompt_file}&gt; &amp;&amp; echo &quot;done&quot;</string>'
		);
	});

	it('systemd: quotes arguments with spaces and restarts always', () => {
		const unit = renderSystemdUnit({
			...spec,
			kind: 'systemd',
			binary: '/home/me/.config/tines/cli/node_modules/.bin/tines',
			args: daemonArgs({
				url: 'https://t.example',
				name: 'box',
				harness: 'custom',
				command: 'agent "{prompt_file}"',
				maxConcurrent: 2
			}),
			logPath: '/home/me/.config/tines/logs/runner-box.log'
		});
		expect(unit).toContain(
			'ExecStart=/home/me/.config/tines/cli/node_modules/.bin/tines runner daemon --url https://t.example --name box --harness custom --command "agent \\"{prompt_file}\\"" --max-concurrent 2'
		);
		expect(unit).toContain('Environment=PATH=/opt/homebrew/bin:/usr/bin:/bin');
		expect(unit).toContain('StandardOutput=append:/home/me/.config/tines/logs/runner-box.log');
		expect(unit).toContain('Restart=always');
		expect(unit).toContain('WantedBy=default.target');
	});
});

describe('serviceCommands', () => {
	it('launchd: replaces a loaded definition, kickstarts, boots out', () => {
		const cmds = serviceCommands({
			kind: 'launchd',
			name: 'box',
			unitPath: '/Users/me/Library/LaunchAgents/dev.tines.runner.box.plist',
			uid: 501
		});
		expect(cmds.load).toEqual([
			{ argv: ['launchctl', 'bootout', 'gui/501/dev.tines.runner.box'], optional: true },
			{
				argv: [
					'launchctl',
					'bootstrap',
					'gui/501',
					'/Users/me/Library/LaunchAgents/dev.tines.runner.box.plist'
				]
			}
		]);
		expect(cmds.restart).toEqual([
			{ argv: ['launchctl', 'kickstart', '-k', 'gui/501/dev.tines.runner.box'] }
		]);
		expect(cmds.unload).toEqual([
			{ argv: ['launchctl', 'bootout', 'gui/501/dev.tines.runner.box'], optional: true }
		]);
	});

	it('systemd: reloads, enables now, lingers; restarts; disables', () => {
		const cmds = serviceCommands({
			kind: 'systemd',
			name: 'box',
			unitPath: '/home/me/.config/systemd/user/tines-runner-box.service',
			uid: 1000
		});
		expect(cmds.load.map((c) => c.argv)).toEqual([
			['systemctl', '--user', 'daemon-reload'],
			['systemctl', '--user', 'enable', '--now', 'tines-runner-box'],
			['loginctl', 'enable-linger']
		]);
		expect(cmds.load[2]!.optional).toBe(true);
		expect(cmds.restart.map((c) => c.argv)).toEqual([
			['systemctl', '--user', 'restart', 'tines-runner-box']
		]);
		expect(cmds.unload[0]!.argv).toEqual([
			'systemctl',
			'--user',
			'disable',
			'--now',
			'tines-runner-box'
		]);
	});
});

describe('matchDaemonProcesses', () => {
	const prefix = '/Users/me/.config/tines/cli';
	const query = { name: 'macbook-codex', hostname: 'macbook', prefix, selfPid: 999 };

	it('finds the daemon for this name however it was launched, and tells managed from foreign', () => {
		const ps = [
			'  17985 node /Users/me/.nvm/versions/node/v26.2.0/bin/tines runner daemon --url https://t.example --name macbook-codex --harness codex --max-concurrent 4',
			'  18000 node /Users/me/.config/tines/cli/node_modules/.bin/tines runner daemon --url https://t.example --name macbook-codex --harness codex',
			'  18001 node /Users/me/.config/tines/cli/node_modules/.bin/tines runner daemon --name=macbook-claude --harness claude-code',
			'  18002 /usr/bin/tines runner daemon --harness codex',
			'  999 node /x/tines runner install --name macbook-codex',
			'  18003 grep runner daemon --name macbook-codex',
			'  18004 node /x/tines runners show macbook-codex'
		].join('\n');
		expect(matchDaemonProcesses(ps, query)).toEqual([
			{ pid: 17985, args: expect.stringContaining('.nvm/'), managed: false },
			{ pid: 18000, args: expect.stringContaining('.config/tines/cli/'), managed: true }
		]);
		// An unnamed daemon is called after the machine.
		expect(matchDaemonProcesses(ps, { ...query, name: 'macbook' }).map((p) => p.pid)).toEqual([
			18002
		]);
		expect(
			matchDaemonProcesses(ps, { ...query, name: 'macbook-claude' }).map((p) => p.pid)
		).toEqual([18001]);
	});

	it('ignores a prefix that merely shares a string prefix', () => {
		const ps =
			'  1 node /Users/me/.config/tines/cli-old/node_modules/.bin/tines runner daemon --name macbook-codex';
		expect(matchDaemonProcesses(ps, query)).toEqual([
			{ pid: 1, args: expect.any(String), managed: false }
		]);
	});
});

describe('daemonStartedLine', () => {
	it("matches the daemon's own reconnect and register lines for exactly this name", () => {
		const re = daemonStartedLine('box.1');
		expect(re.test('[10:00:00] reconnecting as runner "box.1" (rnr_x) — token from /cfg')).toBe(
			true
		);
		expect(re.test('[10:00:00] registered runner "box.1" (rnr_x); token stored in /cfg')).toBe(
			true
		);
		expect(re.test('[10:00:00] registered runner "box-1" (rnr_x)')).toBe(false);
	});
});
