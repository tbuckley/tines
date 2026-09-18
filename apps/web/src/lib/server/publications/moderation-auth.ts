import type { RequestEvent } from '@sveltejs/kit';
import { ApiFail, requireActor, runKeyForbidden, type ActorContext } from '../api/core';
import { hostModerationConfig } from './config';

export function assertHostModerator(actor: ActorContext, env: Env): void {
	if (actor.agentRunId) throw runKeyForbidden();
	if (!actor.viaSession || actor.apiKeyId)
		throw new ApiFail(403, 'session_required', 'Host moderation requires a browser session');
	const config = hostModerationConfig(env);
	if (!config.moderatorUserIds.has(actor.userId))
		throw new ApiFail(403, 'moderator_forbidden', 'Host moderator access is required');
}

export async function requireHostModerator(event: RequestEvent): Promise<ActorContext> {
	if (!event.platform) throw new ApiFail(500, 'no_platform', 'Platform bindings unavailable');
	const actor = await requireActor(event);
	assertHostModerator(actor, event.platform.env);
	return actor;
}
