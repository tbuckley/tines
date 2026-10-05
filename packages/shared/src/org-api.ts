/** Wire types for organizations (docs/organizations.md). */

export type OrganizationKind = 'personal' | 'shared';
export type OrganizationRole = 'owner' | 'manager' | 'member';

export interface OrganizationSummary {
	id: string;
	name: string;
	kind: OrganizationKind;
	/** The viewer's role in it. */
	role: OrganizationRole;
	owner: { id: string; name: string };
	member_count: number;
	project_count: number;
	revision: number;
	created_at: number;
}

export interface OrganizationMember {
	user_id: string;
	name: string;
	email: string | null;
	role: OrganizationRole;
	joined_at: number;
	revision: number;
}

export interface OrganizationInvitation {
	id: string;
	email: string;
	expires_at: number;
	created_at: number;
	delivery_status: 'pending' | 'sent' | 'failed';
}

export interface OrganizationDetail extends OrganizationSummary {
	members: OrganizationMember[];
	/** Pending invitations (owners and managers only). */
	invitations: OrganizationInvitation[];
	projects: { id: string; name: string; archived_at: number | null; issue_count: number }[];
}

export interface CreateOrganizationRequest {
	name: string;
}

/** What moving a project between organizations does, reviewed before it is confirmed. */
export interface ProjectMovePreview {
	project: { id: string; name: string };
	from: { id: string; name: string; kind: OrganizationKind };
	to: { id: string; name: string; kind: OrganizationKind };
	/** People who gain or lose access to the project. */
	people: { gain: { id: string; name: string }[]; lose: { id: string; name: string }[] };
	/** Every workflow in use, and what happens to it. */
	workflows: {
		id: string;
		name: string;
		handling: 'moves' | 'system' | 'copy';
		issues: number;
		schedules: number;
	}[];
	labels: { id: string; name: string; handling: 'moves' | 'copy' | 'use_existing' }[];
	/** Organization-level items that reach the project now and will not after the move. */
	context_lost: { id: string; kind: string; name: string }[];
	blockers: { code: string; message: string }[];
	/** Binds the confirmation to this review. */
	digest: string;
}

export interface MoveProjectRequest {
	to_organization_id: string;
	expected_digest: string;
}

export interface ShareProjectRequest {
	/** The new shared organization's name (defaults to the project's). */
	name?: string;
	/** Copy the personal organization's items that reach this project into the new one. */
	bring_context?: boolean;
}
