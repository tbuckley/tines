/**
 * Recognises "the Claude account behind this runner is out of usage" from what
 * the harness actually emits, and works out when it comes back (Tines/273).
 *
 * Why this exists: a usage limit kills every run the daemon launches, within a
 * second each, and the supervisor's only reading of a non-zero harness exit is
 * "the work failed" — so three strikes park the issue, and the fleet keeps
 * feeding it more. The runner is the thing that is unavailable, not the work.
 *
 * Two signals, because the incident has two shapes:
 *
 * - **Mid-session**: the stream carries a `rate_limit_event` whose
 *   `rate_limit_info.status` is `rejected`, with an exact `resetsAt`. This is
 *   structured, versioned by the harness and always preferred.
 * - **Already exhausted at process start**: Claude Code prints one human line
 *   on *stderr* and exits 1 with an empty stdout — there is no stream to read.
 *   All we have is prose, so we match its own message prefixes and parse the
 *   `· resets 3pm (America/New_York)` suffix best-effort.
 *
 * Everything here is pure and only ever consulted for a harness that exited
 * non-zero, and only over stderr and the structured stream — never over
 * rendered assistant text, so an agent cannot talk the fleet into a hold.
 * A miss costs exactly today's behaviour.
 */

export interface RateLimitSignal {
	/** Epoch ms the provider said the window resets; null = nothing parseable. */
	resumeAt: number | null;
	source: 'stream' | 'stderr';
	/** Human detail for the finish report and the daemon log. */
	detail: string;
	/** `five_hour` | `seven_day` | … when the stream named the window. */
	limit: string | null;
}

/**
 * The message prefixes Claude Code 2.1.258 uses for its own usage-limit
 * classification, copied verbatim.
 *
 * This is a vendor string, not a contract: when it drifts we simply stop
 * recognising the stderr shape and fall back to today's behaviour (a strike),
 * never to anything worse. Bumping it is a one-line, reviewable change.
 */
export const USAGE_LIMIT_PREFIXES = [
	"You've hit your",
	"You've reached your",
	"You're out of usage credits",
	'Your org is out of usage',
	"Your seat type doesn't include usage credits",
	'Your usage allocation has been disabled by your admin',
	"Your group's usage limit is set to $0",
	"You're out of extra usage"
];

/** The same classifier's one regex form. */
const USAGE_LIMIT_PATTERN = /^Fable(?: [^·\n]{1,40})? requires usage credits\./;

const ANSI = /\x1b\[[0-9;]*m/g;

/** A `resetsAt` may be epoch seconds (what the harness sends) or already ms. */
function toEpochMs(value: number): number {
	// Anything below this is not a plausible millisecond timestamp (it would be
	// 1970), so it is seconds. 10^12 ms is 2001; 10^12 s is year 33658.
	return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
}

interface RateLimitInfo {
	status?: string;
	resetsAt?: number;
	rateLimitType?: string;
}

/**
 * A parsed stream event → a signal when it is a *rejected* rate limit.
 *
 * `allowed` events (the vast majority — one per turn, carrying live headroom)
 * are not a limit and are ignored.
 */
export function rateLimitFromStreamEvent(event: unknown): RateLimitSignal | null {
	if (typeof event !== 'object' || event === null) return null;
	const ev = event as { type?: unknown; rate_limit_info?: unknown };
	if (ev.type !== 'rate_limit_event') return null;
	const info = ev.rate_limit_info;
	if (typeof info !== 'object' || info === null) return null;
	const { status, resetsAt, rateLimitType } = info as RateLimitInfo;
	if (status !== 'rejected') return null;
	const limit = typeof rateLimitType === 'string' && rateLimitType ? rateLimitType : null;
	const resumeAt =
		typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt > 0
			? toEpochMs(resetsAt)
			: null;
	return {
		resumeAt,
		source: 'stream',
		limit,
		detail: `${limit ?? 'usage'} limit rejected${
			resumeAt === null ? '' : ` · resets ${new Date(resumeAt).toISOString()}`
		}`
	};
}

/**
 * One stderr line → a signal when it is one of Claude Code's usage-limit
 * messages. ANSI colouring is stripped first; anything else returns null.
 */
export function rateLimitFromStderrLine(line: string, now: number): RateLimitSignal | null {
	const clean = line.replace(ANSI, '').trim();
	if (!clean) return null;
	const matches =
		USAGE_LIMIT_PREFIXES.some((prefix) => clean.startsWith(prefix)) ||
		USAGE_LIMIT_PATTERN.test(clean);
	if (!matches) return null;
	// "You've hit your session limit · resets 3pm (America/New_York)" — the part
	// after the separator is the time, when there is one at all.
	const [, reset] = clean.split('·');
	const resumeAt = reset ? parseResetTime(reset.replace(/^\s*resets\s*/i, ''), now) : null;
	return { resumeAt, source: 'stderr', limit: null, detail: clean };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The named zone's UTC offset in ms at `at`, via the standard parts trick. */
function zoneOffsetMs(zone: string, at: number): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: zone,
		hour12: false,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	}).formatToParts(new Date(at));
	const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
	// `hour: '2-digit'` with hour12:false renders midnight as 24 in some ICUs.
	const hour = get('hour') % 24;
	const asUtc = Date.UTC(
		get('year'),
		get('month') - 1,
		get('day'),
		hour,
		get('minute'),
		get('second')
	);
	return asUtc - Math.floor(at / 1000) * 1000;
}

/** Wall-clock fields in a named zone → epoch ms, DST-safe (one correction pass). */
function zonedTimeToEpoch(
	zone: string,
	y: number,
	m: number,
	d: number,
	hh: number,
	mm: number
): number {
	const naive = Date.UTC(y, m, d, hh, mm, 0);
	let guess = naive - zoneOffsetMs(zone, naive);
	// Re-check against the offset actually in force at the guess: a spring-forward
	// or fall-back between the two is exactly what this corrects.
	guess = naive - zoneOffsetMs(zone, guess);
	return guess;
}

/** The calendar date `at` falls on in `zone`. */
function zonedDate(zone: string, at: number): { y: number; m: number; d: number } {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: zone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(new Date(at));
	const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
	return { y: get('year'), m: get('month') - 1, d: get('day') };
}

const DURATION = /(\d+)\s*([dhms])/g;

/**
 * The reset time Claude Code prints → epoch ms, or null when it says nothing
 * usable (`later`, an unknown zone, a shape we have not seen).
 *
 * Recognised: `3pm (America/New_York)`, `9:30pm (America/New_York)`,
 * `Sep 8, 3pm (…)`, `Sep 8, 2027, 3pm (…)`, `in 2h 15m`.
 */
export function parseResetTime(text: string, now: number): number | null {
	const raw = text.trim();
	if (!raw) return null;

	const relative = raw.match(/^in\s+(.+)$/i);
	if (relative) {
		let ms = 0;
		let matched = false;
		for (const [, amount, unit] of relative[1].matchAll(DURATION)) {
			const n = Number(amount);
			ms += n * { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 }[unit as 'd' | 'h' | 'm' | 's'];
			matched = true;
		}
		return matched ? now + ms : null;
	}

	// A zone is required: without it the wall-clock time means nothing here.
	const zoned = raw.match(/^(.*?)\s*\(([A-Za-z_]+\/[A-Za-z_+-]+|UTC)\)$/);
	if (!zoned) return null;
	const [, head, zone] = zoned;
	try {
		zoneOffsetMs(zone, now);
	} catch {
		return null; // RangeError: an IANA zone this runtime does not know.
	}

	const clock = head.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
	if (!clock) return null;
	const meridiem = clock[3].toLowerCase();
	const hour12 = Number(clock[1]) % 12;
	const hh = meridiem === 'pm' ? hour12 + 12 : hour12;
	const mm = Number(clock[2] ?? '0');

	const dated = head.match(/^([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:,\s*(\d{4}))?,/);
	if (dated) {
		const month = MONTHS.indexOf(dated[1].toLowerCase());
		if (month === -1) return null;
		const here = zonedDate(zone, now);
		const year = dated[3] ? Number(dated[3]) : here.y;
		let at = zonedTimeToEpoch(zone, year, month, Number(dated[2]), hh, mm);
		// A bare "Jan 2" printed in late December means next year.
		if (!dated[3] && at < now - 86_400_000)
			at = zonedTimeToEpoch(zone, year + 1, month, Number(dated[2]), hh, mm);
		return at;
	}

	// Bare wall-clock: the next occurrence, today if still ahead else tomorrow.
	const today = zonedDate(zone, now);
	const at = zonedTimeToEpoch(zone, today.y, today.m, today.d, hh, mm);
	return at > now ? at : zonedTimeToEpoch(zone, today.y, today.m, today.d + 1, hh, mm);
}

/**
 * Per-run accumulator: the daemon feeds it every parsed stream event and every
 * stderr chunk, then asks once, at exit, whether this run died of a limit.
 *
 * Line buffering mirrors `ClaudeStreamRenderer`: chunk boundaries fall wherever
 * the pipe decides, and the one line that matters may straddle two of them.
 */
export class RateLimitDetector {
	private stream: RateLimitSignal | null = null;
	private stderr: RateLimitSignal | null = null;
	private pending = '';

	noteStreamEvent(event: unknown): void {
		const signal = rateLimitFromStreamEvent(event);
		// Last one wins: a later rejection carries the later reset.
		if (signal) this.stream = signal;
	}

	noteStderr(chunk: string, now: number = Date.now()): void {
		this.pending += chunk;
		let nl = this.pending.indexOf('\n');
		while (nl !== -1) {
			this.line(this.pending.slice(0, nl), now);
			this.pending = this.pending.slice(nl + 1);
			nl = this.pending.indexOf('\n');
		}
	}

	/** Flushes a trailing partial line. Call once the harness has exited. */
	finish(now: number = Date.now()): void {
		if (this.pending) {
			this.line(this.pending, now);
			this.pending = '';
		}
	}

	/** The structured signal when there is one; the prose only as a fallback. */
	signal(): RateLimitSignal | null {
		return this.stream ?? this.stderr;
	}

	private line(raw: string, now: number): void {
		const signal = rateLimitFromStderrLine(raw, now);
		if (signal) this.stderr = signal;
	}
}
