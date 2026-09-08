import type {
	AllowedTransition,
	EffectivePromptPart,
	Round,
	RoundArtifactChange
} from '@tines/shared';

export function splitBrief(source: string): { lead: string; rest: string } {
	const normalized = source.replaceAll('\r\n', '\n').trim();
	if (!normalized) return { lead: '', rest: '' };
	const blocks = normalized.split(/\n\s*\n/);
	let end = 0;
	while (end < blocks.length && /^#{1,6}\s/.test(blocks[end])) end += 1;
	// Only split a plain paragraph. Lists, fences, HTML and indented code can
	// contain blank lines internally, so keeping the source whole is safer.
	if (/^(?:\s*(```|~~~|[-+*]\s|\d+[.)]\s|>|<)| {4})/.test(blocks[end] ?? ''))
		return { lead: normalized, rest: '' };
	if (end < blocks.length) end += 1;
	return { lead: blocks.slice(0, end).join('\n\n'), rest: blocks.slice(end).join('\n\n') };
}

const plain = (s: string) =>
	s
		.replace(/[`*_~[\]()]/g, '')
		.replace(/\s+/g, ' ')
		.trim();

export function transitionMeanings(
	parts: Pick<EffectivePromptPart, 'body'>[],
	transitions: AllowedTransition[]
): Record<string, string> {
	const result: Record<string, string> = {};
	const ordered = [...transitions].sort((a, b) => b.name.length - a.name.length);
	for (const part of parts) {
		let fenced = false;
		for (const line of part.body.replaceAll('\r\n', '\n').split('\n')) {
			if (/^\s*```/.test(line)) {
				fenced = !fenced;
				continue;
			}
			if (fenced) continue;
			const match = line.match(/^\s*[-*+]\s+(.+)$/);
			if (!match) continue;
			const text = plain(match[1]);
			const transition = ordered.find((t) => {
				const name = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				return new RegExp(`^${name}(?=$|\\s*(?:[:—–→-]|\\b(?:for|if|to)\\b))`, 'i').test(text);
			});
			if (transition) result[transition.transition_id] = text;
		}
	}
	return result;
}

export function displayStages(round: Round) {
	return [...round.stages].sort((a, b) => {
		if (a.state.position === null) return b.state.position === null ? 0 : 1;
		if (b.state.position === null) return -1;
		return b.state.position - a.state.position;
	});
}

const imagePath = (path: string) => /\.(png|jpe?g|gif|webp|avif)$/i.test(path);

export function latestScreenshots(round: Round): RoundArtifactChange | null {
	let latest: RoundArtifactChange | null = null;
	for (const stage of round.stages)
		for (const run of stage.runs)
			for (const artifact of run.artifacts)
				if (
					artifact.name === 'screenshots' &&
					artifact.artifact_type === 'folder' &&
					(!latest || artifact.to_version > latest.to_version)
				)
					latest = artifact;
	return latest;
}

export function screenshotPaths(artifact: RoundArtifactChange): string[] {
	const paths = (artifact.files ?? []).filter(imagePath).sort();
	const desktop = paths.filter((p) => /-desktop\.[^.]+$/i.test(p));
	const selected: string[] = [];
	for (const d of desktop) {
		const mobile = paths.find(
			(p) => p.replace(/-mobile(?=\.[^.]+$)/i, '') === d.replace(/-desktop(?=\.[^.]+$)/i, '')
		);
		if (mobile && selected.length <= 4) selected.push(d, mobile);
	}
	for (const path of paths)
		if (selected.length < 6 && !selected.includes(path)) selected.push(path);
	return selected;
}

export function artifactContentUrl(issueId: string, name: string, version: number, path: string) {
	const query = new URLSearchParams({ version: String(version), path, inline: '1' });
	return `/api/v1/issues/${issueId}/artifacts/${encodeURIComponent(name)}/content?${query}`;
}
