/** Shared email binding; the E2E worker supplies its isolated EMAIL sink. */
const isolatedSink = new Map<string, string>();
export function readIsolatedInvitation(id: string): string | null {
	return import.meta.env.VITE_TINES_E2E === '1' ? (isolatedSink.get(id) ?? null) : null;
}
export async function sendInvitationEmail(
	env: Env,
	input: { email: string; owner: string; project: string; url: string; expiresAt: number }
): Promise<void> {
	if (!env.EMAIL || !env.EMAIL_FROM) throw new Error('Invitation email is not configured');
	const subject = `${input.owner} invited you to ${input.project}`;
	const text = `${input.owner} invited you to join the whole ${input.project} project in Tines. Open this invitation while signed in with ${input.email}:\n\n${input.url}\n\nThis link expires ${new Date(input.expiresAt).toUTCString()}; once you join, you stay a member until the owner removes you or you leave. If you did not expect this invitation, ignore this email.`;
	// Plain text avoids embedding untrusted names or links in an HTML context.
	await env.EMAIL.send({
		to: input.email,
		from: { email: env.EMAIL_FROM, name: 'Tines' },
		subject,
		text
	});
}

export function recordIsolatedInvitation(id: string, url: string): void {
	if (import.meta.env.VITE_TINES_E2E === '1') isolatedSink.set(id, url);
}
