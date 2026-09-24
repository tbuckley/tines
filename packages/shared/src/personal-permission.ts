/**
 * How a person's permission for their own agents reads in a roster or card.
 *
 * The owner's permission defaults on (decision 2026-09-24,
 * specs/projects/SHARING_OWNER_DEFAULT_2026-09-24.md): with no current choice
 * the owner's agents are admitted, so "unset" is shown as what it means. A
 * member's unset stays unset — members are opt-in.
 */
export function personalPermissionLabel(role: string, value: string): string {
	if (role === 'owner' && value === 'unset') return 'on (owner default)';
	return value;
}
