import type {
	ApiErrorBody,
	ApiKey,
	ApiKeyCreated,
	Comment,
	ContextItem,
	ContextListFilters,
	CreateApiKeyRequest,
	CreateCommentRequest,
	CreateContextItemRequest,
	CreateIssueRequest,
	CreateIssueResponse,
	CreateProjectRequest,
	CreateWorkflowRequest,
	DeleteAnchorRequest,
	DeleteAnchorResponse,
	EffectiveContext,
	EventFilters,
	LaunchPromptResponse,
	Issue,
	IssueDetail,
	IssueFilters,
	ListResponse,
	PageParams,
	Project,
	Schedule,
	ScheduleFilters,
	StateCategory,
	TinesEvent,
	TransitionIssueRequest,
	UpdateContextItemRequest,
	UpdateIssueRequest,
	UpdateProjectRequest,
	UpdateScheduleRequest,
	UpdateWorkflowRequest,
	WorkflowResponse
} from './types.js';

export interface TimeResponse {
	/** ISO 8601 timestamp (UTC). */
	time: string;
	/** Milliseconds since the Unix epoch. */
	unix: number;
}

export interface ApiClientOptions {
	/** Base URL of the Tines API, e.g. "http://localhost:5173". */
	baseUrl: string;
	/** API key sent as `Authorization: Bearer <key>`. Omit for cookie auth. */
	apiKey?: string;
	/** Custom fetch implementation (defaults to global fetch). */
	fetch?: typeof globalThis.fetch;
}

/** Thrown for non-2xx responses; carries the structured error body. */
export class ApiError extends Error {
	status: number;
	code: string;
	details?: Record<string, unknown>;

	constructor(status: number, body: ApiErrorBody['error'] | null, fallback: string) {
		super(body?.message ?? fallback);
		this.name = 'ApiError';
		this.status = status;
		this.code = body?.code ?? 'unknown';
		this.details = body?.details;
	}
}

function query(params: object): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params) as [string, unknown][]) {
		if (value !== undefined && value !== '' && value !== null) search.set(key, String(value));
	}
	const s = search.toString();
	return s ? `?${s}` : '';
}

export function createApiClient(options: ApiClientOptions) {
	const base = options.baseUrl.replace(/\/+$/, '');
	const fetchFn = options.fetch ?? globalThis.fetch;

	async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const headers: Record<string, string> = { accept: 'application/json' };
		if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
		if (body !== undefined) headers['content-type'] = 'application/json';

		const res = await fetchFn(`${base}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body)
		});

		if (!res.ok) {
			let parsed: ApiErrorBody['error'] | null = null;
			try {
				parsed = ((await res.json()) as ApiErrorBody).error ?? null;
			} catch {
				// Non-JSON error body; fall through to the status-line message.
			}
			throw new ApiError(res.status, parsed, `${method} ${path} failed: ${res.status}`);
		}
		if (res.status === 204) return undefined as T;
		return (await res.json()) as T;
	}

	const get = <T>(path: string) => request<T>('GET', path);

	return {
		getTime: () => get<TimeResponse>('/api/time'),

		// Projects
		listProjects: (page: PageParams = {}) =>
			get<ListResponse<Project>>(`/api/v1/projects${query(page)}`),
		createProject: (body: CreateProjectRequest) =>
			request<Project>('POST', '/api/v1/projects', body),
		getProject: (id: string) => get<Project>(`/api/v1/projects/${id}`),
		updateProject: (id: string, body: UpdateProjectRequest) =>
			request<Project>('PATCH', `/api/v1/projects/${id}`, body),
		deleteProject: (id: string, body?: DeleteAnchorRequest) =>
			request<DeleteAnchorResponse | void>('DELETE', `/api/v1/projects/${id}`, body),

		// Workflows
		listWorkflows: (page: PageParams = {}) =>
			get<ListResponse<WorkflowResponse>>(`/api/v1/workflows${query(page)}`),
		createWorkflow: (body: CreateWorkflowRequest) =>
			request<WorkflowResponse>('POST', '/api/v1/workflows', body),
		getWorkflow: (id: string) => get<WorkflowResponse>(`/api/v1/workflows/${id}`),
		updateWorkflow: (id: string, body: UpdateWorkflowRequest) =>
			request<WorkflowResponse>('PATCH', `/api/v1/workflows/${id}`, body),
		deleteWorkflow: (id: string, body?: DeleteAnchorRequest) =>
			request<DeleteAnchorResponse | void>('DELETE', `/api/v1/workflows/${id}`, body),

		// Issues
		listIssues: (filters: IssueFilters & PageParams = {}) =>
			get<ListResponse<Issue>>(`/api/v1/issues${query(filters)}`),
		listProjectIssues: (
			projectId: string,
			filters: { state?: string; category?: StateCategory; hide_done?: boolean } & PageParams = {}
		) => get<ListResponse<Issue>>(`/api/v1/projects/${projectId}/issues${query(filters)}`),
		createIssue: (projectId: string, body: CreateIssueRequest) =>
			request<CreateIssueResponse>('POST', `/api/v1/projects/${projectId}/issues`, body),
		getIssue: (id: string) => get<IssueDetail>(`/api/v1/issues/${id}`),
		getIssueByNumber: (projectId: string, number: number) =>
			get<IssueDetail>(`/api/v1/projects/${projectId}/issues/${number}`),
		updateIssue: (id: string, body: UpdateIssueRequest) =>
			request<IssueDetail>('PATCH', `/api/v1/issues/${id}`, body),
		transitionIssue: (id: string, body: TransitionIssueRequest) =>
			request<IssueDetail>('POST', `/api/v1/issues/${id}/transition`, body),

		// Comments
		listComments: (issueId: string, page: PageParams = {}) =>
			get<ListResponse<Comment>>(`/api/v1/issues/${issueId}/comments${query(page)}`),
		createComment: (issueId: string, body: CreateCommentRequest) =>
			request<Comment>('POST', `/api/v1/issues/${issueId}/comments`, body),

		// Scheduled tasks
		listSchedules: (filters: ScheduleFilters & PageParams = {}) =>
			get<ListResponse<Schedule>>(`/api/v1/schedules${query(filters)}`),
		listProjectSchedules: (projectId: string, page: PageParams = {}) =>
			get<ListResponse<Schedule>>(`/api/v1/projects/${projectId}/schedules${query(page)}`),
		getSchedule: (id: string) => get<Schedule>(`/api/v1/schedules/${id}`),
		updateSchedule: (id: string, body: UpdateScheduleRequest) =>
			request<Schedule>('PATCH', `/api/v1/schedules/${id}`, body),
		deleteSchedule: (id: string) => request<void>('DELETE', `/api/v1/schedules/${id}`),
		/** Run now: creates an instance immediately (gate-respecting; 422 when blocked). */
		runSchedule: (id: string) => request<IssueDetail>('POST', `/api/v1/schedules/${id}/run`),

		// Context items
		listContext: (filters: ContextListFilters & PageParams = {}) =>
			get<ListResponse<ContextItem>>(`/api/v1/context${query(filters)}`),
		createContextItem: (body: CreateContextItemRequest) =>
			request<ContextItem>('POST', '/api/v1/context', body),
		getContextItem: (id: string) => get<ContextItem>(`/api/v1/context/${id}`),
		updateContextItem: (id: string, body: UpdateContextItemRequest) =>
			request<ContextItem>('PATCH', `/api/v1/context/${id}`, body),
		deleteContextItem: (id: string) => request<void>('DELETE', `/api/v1/context/${id}`),
		/** Effective context for an issue: the assembled bundle. */
		getIssueContext: (issueId: string) =>
			get<EffectiveContext>(`/api/v1/issues/${issueId}/context`),
		/** Launch prompt: stitched context plus the generated issue block. */
		getIssuePrompt: (issueId: string) =>
			get<LaunchPromptResponse>(`/api/v1/issues/${issueId}/prompt`),

		// Events
		listEvents: (filters: EventFilters & PageParams = {}) =>
			get<ListResponse<TinesEvent>>(`/api/v1/events${query(filters)}`),

		// API keys (create/revoke require a browser session, not a key)
		listApiKeys: () => get<ListResponse<ApiKey>>('/api/v1/api-keys'),
		createApiKey: (body: CreateApiKeyRequest) =>
			request<ApiKeyCreated>('POST', '/api/v1/api-keys', body),
		revokeApiKey: (id: string) => request<void>('DELETE', `/api/v1/api-keys/${id}`)
	};
}

export type ApiClient = ReturnType<typeof createApiClient>;
