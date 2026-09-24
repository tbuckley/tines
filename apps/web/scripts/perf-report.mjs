#!/usr/bin/env node
// Real-user latency report (docs/PERFORMANCE.md, "Real users"): navigation
// percentiles per route and loading-state frequency, from the Workers
// Analytics Engine dataset /api/telemetry writes (lib/server/telemetry.ts has
// the row layout).
//
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_ANALYTICS_TOKEN=… pnpm --filter web perf:report
//
// The token needs only "Account Analytics: Read". Options:
//   --days N        window, default 7
//   --preview       read the preview dataset instead of production
//   --by version    split navigation rows by deployment version (default: route only)
//   --by colo       split by the Cloudflare location that served the user
const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = args.indexOf(name);
	return i === -1 ? fallback : args[i + 1];
};
const days = Number(opt('--days', '7'));
const dataset = args.includes('--preview') ? 'tines_perf_preview' : 'tines_perf';
const by = opt('--by', '');
const split = { version: 'blob7', colo: 'blob5', viewport: 'blob4' }[by];
if (by && !split) throw new Error(`--by must be version, colo or viewport`);
if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('--days must be 1-90');

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_ANALYTICS_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) {
	console.error(
		'Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ANALYTICS_TOKEN (Account Analytics: Read).'
	);
	process.exit(1);
}

async function sql(query) {
	const res = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`,
		{ method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: query }
	);
	if (!res.ok) throw new Error(`Analytics Engine ${res.status}: ${await res.text()}`);
	return (await res.json()).data;
}

const window = `timestamp > NOW() - INTERVAL '${days}' DAY`;
const q = (p, col = 'double1') => `quantileExactWeighted(${p})(${col}, _sample_interval)`;
const groupCols = ['blob1', ...(split ? [split] : [])];

const navs = await sql(`
	SELECT ${groupCols.join(', ')},
		SUM(_sample_interval) AS n,
		${q(0.5)} AS p50, ${q(0.75)} AS p75, ${q(0.95)} AS p95,
		${q(0.75, 'double2')} AS wait_p75,
		${q(0.75, 'double3')} AS app_p75,
		SUM(_sample_interval * double5) / SUM(_sample_interval) AS preloaded
	FROM ${dataset}
	WHERE index1 = 'nav' AND blob3 != 'enter' AND ${window}
	GROUP BY ${groupCols.join(', ')}
	ORDER BY n DESC
	FORMAT JSON`);

const loading = await sql(`
	SELECT blob2 AS id, SUM(_sample_interval) AS shown, ${q(0.5)} AS p50, ${q(0.95)} AS p95
	FROM ${dataset}
	WHERE index1 = 'loading' AND ${window}
	GROUP BY id ORDER BY shown DESC
	FORMAT JSON`);

const [{ navigations = 0 } = {}] = await sql(`
	SELECT SUM(_sample_interval) AS navigations FROM ${dataset}
	WHERE index1 = 'nav' AND ${window} FORMAT JSON`);

const r = (x) => (x < 0 ? '—' : Math.round(Number(x)));
console.log(
	`\nIn-app navigations, last ${days} days (${dataset}); target p75 ≤ 200 ms, p95 ≤ 400 ms\n`
);
console.log(
	[
		'route',
		...(split ? [by] : []),
		'n',
		'p50',
		'p75',
		'p95',
		'wait p75',
		'server p75',
		'preloaded'
	].join('\t')
);
for (const row of navs)
	console.log(
		[
			row.blob1,
			...(split ? [row[split]] : []),
			row.n,
			r(row.p50),
			r(row.p75),
			r(row.p95),
			r(row.wait_p75),
			r(row.app_p75),
			`${Math.round(row.preloaded * 100)}%`
		].join('\t')
	);
console.log(`\nLoading states (per 100 navigations of any kind: ${navigations})\n`);
console.log(['id', 'shown', 'per 100', 'p50 ms', 'p95 ms'].join('\t'));
for (const row of loading)
	console.log(
		[
			row.id,
			row.shown,
			navigations ? ((row.shown / navigations) * 100).toFixed(1) : '—',
			r(row.p50),
			r(row.p95)
		].join('\t')
	);
