import { sql, type Kysely } from 'kysely';
import type { Database } from '$lib/server/db';

/**
 * One stable, owner-scoped SQL witness for inventory and the later guarded
 * apply. JSON rows include every field that can change matching, ordering,
 * payload bytes, topology, or the drain decision. Artifact growth is excluded.
 */
export async function readRetirementWitness(db: Kysely<Database>, userId: string): Promise<string> {
	const row = await db
		.selectNoFrom((eb) => [
			sql<string>`json_object(
				'workflows', COALESCE((SELECT json_group_array(json(row_json)) FROM (
					SELECT json_object('id', id, 'user_id', user_id, 'name', name,
						'description', description, 'initial_state_id', initial_state_id,
						'created_at', created_at, 'updated_at', updated_at) AS row_json
					FROM workflow WHERE user_id = ${userId} OR user_id IS NULL ORDER BY id
				)), '[]'),
				'states', COALESCE((SELECT json_group_array(json(row_json)) FROM (
					SELECT json_object('id', s.id, 'workflow_id', s.workflow_id, 'name', s.name,
						'category', s.category, 'position', s.position,
						'inherits_from_state_id', s.inherits_from_state_id, 'created_at', s.created_at) AS row_json
					FROM workflow_state s JOIN workflow w ON w.id = s.workflow_id
					WHERE w.user_id = ${userId} OR w.user_id IS NULL ORDER BY s.id
				)), '[]'),
				'transitions', COALESCE((SELECT json_group_array(json(row_json)) FROM (
					SELECT json_object('id', t.id, 'workflow_id', t.workflow_id, 'name', t.name,
						'from_state_id', t.from_state_id, 'to_state_id', t.to_state_id,
						'requirements', t.requirements) AS row_json
					FROM workflow_transition t JOIN workflow w ON w.id = t.workflow_id
					WHERE w.user_id = ${userId} OR w.user_id IS NULL ORDER BY t.id
				)), '[]'),
				'projects', COALESCE((SELECT json_group_array(json(row_json)) FROM (
					SELECT json_object('id', id, 'name', name, 'description', description,
						'default_workflow_id', default_workflow_id, 'archived_at', archived_at,
						'created_at', created_at, 'updated_at', updated_at) AS row_json
					FROM project WHERE user_id = ${userId} ORDER BY id
				)), '[]'),
				'labels', COALESCE((SELECT json_group_array(json(row_json)) FROM (
					SELECT json_object('id', id, 'name', name, 'color', color,
						'description', description, 'created_at', created_at, 'updated_at', updated_at) AS row_json
					FROM label WHERE user_id = ${userId} ORDER BY id
				)), '[]'),
				'issues', COALESCE((SELECT json_group_array(json(row_json)) FROM (
					SELECT json_object('id', i.id, 'project_id', i.project_id, 'number', i.number,
						'workflow_id', i.workflow_id, 'state_id', i.state_id,
						'project_assignment_token', i.project_assignment_token,
						'created_at', i.created_at, 'updated_at', i.updated_at) AS row_json
					FROM issue i JOIN project p ON p.id = i.project_id WHERE p.user_id = ${userId} ORDER BY i.id
				)), '[]'),
				'issue_labels', COALESCE((SELECT json_group_array(json(row_json)) FROM (
					SELECT json_object('issue_id', il.issue_id, 'label_id', il.label_id,
						'created_at', il.created_at) AS row_json
					FROM issue_label il JOIN issue i ON i.id = il.issue_id JOIN project p ON p.id = i.project_id
					WHERE p.user_id = ${userId} ORDER BY il.issue_id, il.label_id
				)), '[]'),
				'context_items', COALESCE((SELECT json_group_array(json(row_json)) FROM (
					SELECT json_object('id', id, 'kind', kind, 'name', name, 'description', description,
						'project_id', project_id, 'workflow_state_id', workflow_state_id,
						'issue_id', issue_id, 'label_id', label_id, 'body', body,
						'repo_url', repo_url, 'repo_branch', repo_branch, 'repo_dir', repo_dir,
						'config', config, 'position', position, 'version', version,
						'created_at', created_at, 'updated_at', updated_at) AS row_json
					FROM context_item WHERE user_id = ${userId} AND kind != 'artifact' ORDER BY id
				)), '[]'),
				'context_files', COALESCE((SELECT json_group_array(json(row_json)) FROM (
					SELECT json_object('id', f.id, 'context_item_id', f.context_item_id, 'path', f.path,
						'content', f.content, 'created_at', f.created_at, 'updated_at', f.updated_at) AS row_json
					FROM context_item_file f JOIN context_item c ON c.id = f.context_item_id
					WHERE c.user_id = ${userId} AND c.kind != 'artifact' ORDER BY f.context_item_id, f.path, f.id
				)), '[]'),
				'active_runs', COALESCE((SELECT json_group_array(json(row_json)) FROM (
					SELECT json_object('id', id, 'issue_id', issue_id, 'status', status,
						'state_id_at_start', state_id_at_start, 'created_at', created_at,
						'started_at', started_at) AS row_json
					FROM agent_run WHERE user_id = ${userId}
						AND status IN ('assigned', 'launching', 'running') ORDER BY id
				)), '[]')
			)`.as('witness')
		])
		.executeTakeFirstOrThrow();
	return row.witness;
}
