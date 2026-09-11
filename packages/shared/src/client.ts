import type {
	AddIssueLabelsResponse,
	AddIssueLinkRequest,
	AgentRun,
	AgentRunDetail,
	ApiErrorBody,
	CreateLabelRequest,
	DeleteLabelRequest,
	DeleteLabelResponse,
	Label,
	LabelWithUsage,
	UpdateLabelRequest,
	AppendRunLogRequest,
	AppendRunLogResponse,
	FinishRunRequest,
	RegisterRunnerRequest,
	RunnerPollRequest,
	RunnerPollResponse,
	RunnerTokenResponse,
	ApiKey,
	RunKeyFilter,
	ApiKeyCreated,
	AppendContextRequest,
	Artifact,
	ArtifactDetail,
	ArtifactListResponse,
	ArtifactSiteLink,
	Comment,
	ContextItem,
	ContextListFilters,
	CreateApiKeyRequest,
	CreateCommentRequest,
	CreateContextItemRequest,
	CreateIssueRequest,
	CreateIssueResponse,
	CreateProjectRequest,
	CreateProjectResponse,
	CreateRoutingRuleRequest,
	CreateRunnerRequest,
	CreateWorkflowRequest,
	ExportLibraryOptions,
	ImportLibraryRequest,
	ImportLibraryResponse,
	LibraryDocument,
	DeleteAnchorRequest,
	DeleteAnchorResponse,
	DeleteRunnerRequest,
	DispatchExplainer,
	EffectiveContext,
	IssueTransferPreview,
	IssueTransferRequest,
	IssueTransferResult,
	EventFilters,
	FleetQueue,
	LaunchPromptResponse,
	IssueDetail,
	IssueFilters,
	IssueJournalResponse,
	IssueLink,
	IssueListItem,
	ListResponse,
	ListStartersResponse,
	PageParams,
	Project,
	ProjectListFilters,
	ArchiveProjectResponse,
	UnarchiveProjectResponse,
	RoutingRule,
	RoutingRuleWithWarnings,
	RunFilters,
	Runner,
	Schedule,
	ScheduleFilters,
	StateCategory,
	SupervisorSettings,
	SupervisorSettingsResponse,
	TinesEvent,
	TransitionIssueRequest,
	UpdateCommentRequest,
	UpdateContextItemRequest,
	UpdateIssueRequest,
	UpsertArtifactRequest,
	UpdateProjectRequest,
	UpdateRoutingRuleRequest,
	UpdateRunnerRequest,
	UpdateScheduleRequest,
	UpdatePreferencesRequest,
	UpdateSupervisorSettingsRequest,
	UpdateWorkflowRequest,
	UserPreferences,
	WorkflowResponse
} from './types.js';
import type { ResolvedUsageFilters, UsageBy, UsageReport, UsageWindow } from './usage.js';

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

/**
 * The runtime's own error code for a failed connection, when it has one.
 * undici wraps the real cause one (DNS/dual-stack failures two, inside an
 * AggregateError) levels down from the `TypeError: fetch failed` it throws.
 */
function causeCode(err: unknown): string | undefined {
	const seen = new Set<unknown>();
	let node: unknown = err;
	while (node && typeof node === 'object' && !seen.has(node)) {
		seen.add(node);
		const e = node as { code?: unknown; cause?: unknown; errors?: unknown };
		if (typeof e.code === 'string') return e.code;
		node = e.cause ?? (Array.isArray(e.errors) ? e.errors[0] : undefined);
	}
	return undefined;
}

/**
 * Thrown when the request never reached the server: connection refused, DNS
 * failure, TLS error, offline. `fetch` itself only says "fetch failed", which
 * omits the one fact the caller needs — which server was tried — so this
 * names the base URL and the request, keeping the original error as `cause`.
 */
export class ApiNetworkError extends Error {
	/** Method of the request that never completed. */
	method: string;
	/** Request path, query string included. */
	path: string;
	/** Base URL the client was built with; `''` for a same-origin caller. */
	baseUrl: string;
	/** The URL that was attempted (`baseUrl + path`). */
	url: string;
	/** The runtime's code for the failure (`ECONNREFUSED`, `ENOTFOUND`, …), when it gives one. */
	code?: string;

	constructor(method: string, path: string, baseUrl: string, cause: unknown) {
		const code = causeCode(cause);
		const detail = code ?? (cause instanceof Error ? cause.message : String(cause));
		// An empty base URL means same-origin (the web app): naming it would
		// print `could not reach  (…)`, so describe it instead.
		super(`${method} ${path}: could not reach ${baseUrl || 'the server'} (${detail})`, { cause });
		this.name = 'ApiNetworkError';
		this.method = method;
		this.path = path;
		this.baseUrl = baseUrl;
		this.url = `${baseUrl}${path}`;
		this.code = code;
	}
}

function query(params: object): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params) as [string, unknown][]) {
		if (value === undefined || value === '' || value === null) continue;
		// Array values repeat the key (`?label=a&label=b`) — the shape the
		// repeatable filters expect.
		if (Array.isArray(value)) for (const v of value) search.append(key, String(v));
		else search.set(key, String(value));
	}
	const s = search.toString();
	return s ? `?${s}` : '';
}

export function createApiClient(options: ApiClientOptions) {
	const base = options.baseUrl.replace(/\/+$/, '');
	const fetchFn = options.fetch ?? globalThis.fetch;

	/**
	 * Every request goes through here, so a transport failure is reported as an
	 * ApiNetworkError naming the base URL rather than a bare "fetch failed".
	 */
	async function send(method: string, path: string, init: RequestInit): Promise<Response> {
		try {
			return await fetchFn(`${base}${path}`, init);
		} catch (err) {
			throw new ApiNetworkError(method, path, base, err);
		}
	}

	async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const headers: Record<string, string> = { accept: 'application/json' };
		if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
		if (body !== undefined) headers['content-type'] = 'application/json';

		const res = await send(method, path, {
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

	/** Raw (non-JSON) request; returns the Response after error mapping. */
	async function raw(
		method: string,
		path: string,
		opts: {
			body?: string | Uint8Array | ArrayBuffer | FormData;
			headers?: Record<string, string>;
		} = {}
	): Promise<Response> {
		const headers: Record<string, string> = { ...(opts.headers ?? {}) };
		if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
		// A Uint8Array view is copied to a plain ArrayBuffer: every fetch
		// implementation in play accepts that shape without lib-specific types.
		const body =
			opts.body instanceof Uint8Array
				? (opts.body.buffer.slice(
						opts.body.byteOffset,
						opts.body.byteOffset + opts.body.byteLength
					) as ArrayBuffer)
				: opts.body;
		const res = await send(method, path, { method, headers, body });
		if (!res.ok) {
			let parsed: ApiErrorBody['error'] | null = null;
			try {
				parsed = ((await res.json()) as ApiErrorBody).error ?? null;
			} catch {
				// Non-JSON error body; fall through to the status-line message.
			}
			throw new ApiError(res.status, parsed, `${method} ${path} failed: ${res.status}`);
		}
		return res;
	}

	const artifactPath = (issueId: string, name: string, suffix = '') =>
		`/api/v1/issues/${issueId}/artifacts/${encodeURIComponent(name)}${suffix}`;

	return {
		getTime: () => get<TimeResponse>('/api/time'),

		// Projects
		listProjects: (params: ProjectListFilters & PageParams = {}) =>
			get<ListResponse<Project>>(`/api/v1/projects${query(params)}`),
		createProject: (body: CreateProjectRequest) =>
			request<CreateProjectResponse>('POST', '/api/v1/projects', body),
		listStarters: () => get<ListStartersResponse>('/api/v1/projects/starters'),
		getProject: (id: string) => get<Project>(`/api/v1/projects/${id}`),
		updateProject: (id: string, body: UpdateProjectRequest) =>
			request<Project>('PATCH', `/api/v1/projects/${id}`, body),
		deleteProject: (id: string, body?: DeleteAnchorRequest) =>
			request<DeleteAnchorResponse | void>('DELETE', `/api/v1/projects/${id}`, body),
		archiveProject: (id: string) =>
			request<ArchiveProjectResponse>('POST', `/api/v1/projects/${id}/archive`),
		unarchiveProject: (id: string) =>
			request<UnarchiveProjectResponse>('POST', `/api/v1/projects/${id}/unarchive`),

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
			get<ListResponse<IssueListItem>>(`/api/v1/issues${query(filters)}`),
		listLabels: () => get<{ items: LabelWithUsage[] }>('/api/v1/labels'),
		createLabel: (body: CreateLabelRequest) => request<Label>('POST', '/api/v1/labels', body),
		updateLabel: (labelRef: string, body: UpdateLabelRequest) =>
			request<Label>('PATCH', `/api/v1/labels/${encodeURIComponent(labelRef)}`, body),
		deleteLabel: (labelRef: string, body: DeleteLabelRequest = {}) =>
			request<DeleteLabelResponse>(
				'DELETE',
				`/api/v1/labels/${encodeURIComponent(labelRef)}`,
				body
			),
		addIssueLabels: (issueId: string, labels: string[]) =>
			request<AddIssueLabelsResponse>('POST', `/api/v1/issues/${issueId}/labels`, { labels }),
		removeIssueLabel: (issueId: string, labelRef: string) =>
			request<void>('DELETE', `/api/v1/issues/${issueId}/labels/${encodeURIComponent(labelRef)}`),
		listProjectIssues: (
			projectId: string,
			filters: {
				state?: string;
				category?: StateCategory;
				hide_done?: boolean;
				ready?: boolean;
				q?: string;
				brief?: boolean;
			} & PageParams = {}
		) => get<ListResponse<IssueListItem>>(`/api/v1/projects/${projectId}/issues${query(filters)}`),
		createIssue: (projectId: string, body: CreateIssueRequest) =>
			request<CreateIssueResponse>('POST', `/api/v1/projects/${projectId}/issues`, body),
		getIssue: (id: string) => get<IssueDetail>(`/api/v1/issues/${id}`),
		getIssueByNumber: (projectId: string, number: number) =>
			get<IssueDetail>(`/api/v1/projects/${projectId}/issues/${number}`),
		updateIssue: (id: string, body: UpdateIssueRequest) =>
			request<IssueDetail>('PATCH', `/api/v1/issues/${id}`, body),
		transitionIssue: (id: string, body: TransitionIssueRequest) =>
			request<IssueDetail>('POST', `/api/v1/issues/${id}/transition`, body),
		/** Un-park: clears needs_attention, resets the attempt count. */
		resumeIssue: (id: string) => request<IssueDetail>('POST', `/api/v1/issues/${id}/resume`),
		/** The dispatch explainer: "why isn't this running?". */
		getIssueDispatch: (id: string) => get<DispatchExplainer>(`/api/v1/issues/${id}/dispatch`),

		// Issue links (dependencies & duplicates)
		addIssueLink: (issueId: string, body: AddIssueLinkRequest) =>
			request<IssueLink>('POST', `/api/v1/issues/${issueId}/links`, body),
		removeIssueLink: (issueId: string, linkId: string) =>
			request<void>('DELETE', `/api/v1/issues/${issueId}/links/${linkId}`),

		// Comments
		listComments: (issueId: string, page: PageParams = {}) =>
			get<ListResponse<Comment>>(`/api/v1/issues/${issueId}/comments${query(page)}`),
		createComment: (issueId: string, body: CreateCommentRequest) =>
			request<Comment>('POST', `/api/v1/issues/${issueId}/comments`, body),
		updateComment: (issueId: string, commentId: string, body: UpdateCommentRequest) =>
			request<Comment>('PATCH', `/api/v1/issues/${issueId}/comments/${commentId}`, body),
		deleteComment: (issueId: string, commentId: string) =>
			request<void>('DELETE', `/api/v1/issues/${issueId}/comments/${commentId}`),

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
		/** Atomic append to a prompt item's body (blank-line separated). */
		appendContextItem: (id: string, body: AppendContextRequest) =>
			request<ContextItem>('POST', `/api/v1/context/${id}/append`, body),
		/** Effective context for an issue: the assembled bundle. */
		getIssueContext: (issueId: string) =>
			get<EffectiveContext>(`/api/v1/issues/${issueId}/context`),
		/**
		 * Which journal this caller's `tines journal` commands target — the
		 * run's launch state for a run key, the issue's current state otherwise.
		 */
		getIssueJournal: (issueId: string) =>
			get<IssueJournalResponse>(`/api/v1/issues/${issueId}/journal`),
		/** Launch prompt: stitched context plus the generated issue block. */
		getIssuePrompt: (issueId: string) =>
			get<LaunchPromptResponse>(`/api/v1/issues/${issueId}/prompt`),
		/**
		 * Review a move to another project: read-only, allocates no number and
		 * writes nothing. Returns the token that binds this exact review.
		 */
		previewIssueTransfer: (issueId: string, destinationProjectId: string) =>
			get<IssueTransferPreview>(
				`/api/v1/issues/${issueId}/transfer${query({ project: destinationProjectId })}`
			),
		/** Commit the reviewed move. The token must come from a fresh preview. */
		transferIssue: (issueId: string, body: IssueTransferRequest) =>
			request<IssueTransferResult>('POST', `/api/v1/issues/${issueId}/transfer`, body),

		// Issue artifacts (name-addressed under the issue)
		listArtifacts: (issueId: string) =>
			get<ArtifactListResponse>(`/api/v1/issues/${issueId}/artifacts`),
		getArtifact: (issueId: string, name: string) =>
			get<ArtifactDetail>(artifactPath(issueId, name)),
		/**
		 * Mints a short-lived signed URL that renders an HTML artifact live
		 * (422 `not_a_site` when the artifact is not HTML / has no index.html).
		 */
		createArtifactSiteLink: (issueId: string, name: string, body: { version?: number } = {}) =>
			request<ArtifactSiteLink>('POST', artifactPath(issueId, name, '/site-link'), body),
		/** JSON upsert for text/link/pr: creates the artifact or appends a version. */
		putArtifact: (issueId: string, name: string, body: UpsertArtifactRequest) =>
			request<Artifact>('PUT', artifactPath(issueId, name), body),
		/** Raw-body upload for `file`: creates the artifact or appends a version. */
		uploadArtifactFile: async (
			issueId: string,
			name: string,
			bytes: Uint8Array | ArrayBuffer,
			opts: { filename: string; contentType: string }
		) => {
			const res = await raw(
				'PUT',
				artifactPath(issueId, name, `/file?filename=${encodeURIComponent(opts.filename)}`),
				{
					body: bytes,
					headers: { 'content-type': opts.contentType }
				}
			);
			return (await res.json()) as Artifact;
		},
		/**
		 * Multipart snapshot upload for `folder`: every file of the new version
		 * in one request (path as the part filename, MIME as the part type).
		 */
		uploadArtifactFolder: async (
			issueId: string,
			name: string,
			files: { path: string; contentType: string; bytes: Uint8Array | ArrayBuffer }[]
		) => {
			const form = new FormData();
			for (const file of files) {
				form.append(
					'file',
					new Blob([file.bytes as ArrayBuffer], { type: file.contentType }),
					file.path
				);
			}
			const res = await raw('PUT', artifactPath(issueId, name, '/folder'), { body: form });
			return (await res.json()) as Artifact;
		},
		/** Bless the current content as fresh: appends a reaffirming version. */
		reaffirmArtifact: (issueId: string, name: string) =>
			request<Artifact>('POST', artifactPath(issueId, name, '/reaffirm')),
		/** Bytes of a version (default: current; `path` selects a folder entry). */
		getArtifactContent: async (
			issueId: string,
			name: string,
			opts: { version?: number; path?: string } = {}
		) => {
			const params = new URLSearchParams();
			if (opts.version !== undefined) params.set('version', String(opts.version));
			if (opts.path !== undefined) params.set('path', opts.path);
			const query = params.toString() ? `?${params.toString()}` : '';
			const res = await raw('GET', artifactPath(issueId, name, `/content${query}`));
			const disposition = res.headers.get('content-disposition') ?? '';
			const filenameMatch = disposition.match(/filename="((?:[^"\\]|\\.)*)"/);
			return {
				bytes: await res.arrayBuffer(),
				content_type: res.headers.get('content-type'),
				filename: filenameMatch ? filenameMatch[1].replaceAll('\\"', '"') : null
			};
		},
		deleteArtifact: (issueId: string, name: string) =>
			request<void>('DELETE', artifactPath(issueId, name)),

		// Events
		listEvents: (filters: EventFilters & PageParams = {}) =>
			get<ListResponse<TinesEvent>>(`/api/v1/events${query(filters)}`),

		// Runners
		listRunners: () => get<ListResponse<Runner>>('/api/v1/runners'),
		createRunner: (body: CreateRunnerRequest) => request<Runner>('POST', '/api/v1/runners', body),
		getRunner: (id: string) => get<Runner>(`/api/v1/runners/${id}`),
		updateRunner: (id: string, body: UpdateRunnerRequest) =>
			request<Runner>('PATCH', `/api/v1/runners/${id}`, body),
		/** Reject-by-default: 422 names referencing rules/pins unless `force`. */
		deleteRunner: (id: string, body?: DeleteRunnerRequest) =>
			request<void>('DELETE', `/api/v1/runners/${id}`, body),
		/** Create/reconnect a local runner; the response's token is shown once. */
		registerRunner: (body: RegisterRunnerRequest) =>
			request<RunnerTokenResponse>('POST', '/api/v1/runners/register', body),
		/** Invalidate the runner token and mint a fresh one (shown once). */
		rotateRunnerToken: (id: string) =>
			request<RunnerTokenResponse>('POST', `/api/v1/runners/${id}/rotate-token`),

		// Local runner protocol (runner-token auth: construct the client with
		// the runner token as `apiKey`)
		pollRunner: (id: string, body: RunnerPollRequest) =>
			request<RunnerPollResponse>('POST', `/api/v1/runners/${id}/poll`, body),
		appendRunLog: (runId: string, body: AppendRunLogRequest) =>
			request<AppendRunLogResponse>('POST', `/api/v1/runs/${runId}/logs`, body),
		finishRun: (runId: string, body: FinishRunRequest) =>
			request<AgentRun>('POST', `/api/v1/runs/${runId}/finish`, body),

		// Agent runs
		listRuns: (filters: RunFilters & PageParams = {}) =>
			get<ListResponse<AgentRun>>(`/api/v1/runs${query(filters)}`),
		getUsage: (
			filters: ResolvedUsageFilters & {
				window?: UsageWindow;
				from?: string;
				to?: string;
				by?: UsageBy;
			} = {}
		) => get<UsageReport>(`/api/v1/usage${query(filters)}`),
		getRun: (id: string) => get<AgentRunDetail>(`/api/v1/runs/${id}`),
		/**
		 * The run's complete log (not the 256 KB tail `getRun` returns) as a
		 * streamed Response, so a multi-megabyte log never has to be held in
		 * memory. `raw` asks for the unrendered harness stream instead.
		 */
		getRunLogFull: (id: string, opts: { raw?: boolean } = {}) =>
			raw('GET', `/api/v1/runs/${id}/log${opts.raw ? '?raw=1' : ''}`, {
				headers: { accept: 'text/plain' }
			}),
		/** Daemon-only: uploads the raw harness stream for a settled run. */
		putRunLogRaw: (id: string, body: Uint8Array) =>
			raw('PUT', `/api/v1/runs/${id}/log/raw`, {
				body,
				headers: {
					'content-type': 'application/x-ndjson',
					'content-length': String(body.byteLength)
				}
			}),
		cancelRun: (id: string) => request<AgentRunDetail>('POST', `/api/v1/runs/${id}/cancel`),

		// Routing rules (one per exact scope; responses carry shadow hints)
		listRoutingRules: () => get<ListResponse<RoutingRuleWithWarnings>>('/api/v1/routing-rules'),
		createRoutingRule: (body: CreateRoutingRuleRequest) =>
			request<RoutingRuleWithWarnings>('POST', '/api/v1/routing-rules', body),
		updateRoutingRule: (id: string, body: UpdateRoutingRuleRequest) =>
			request<RoutingRuleWithWarnings>('PATCH', `/api/v1/routing-rules/${id}`, body),
		deleteRoutingRule: (id: string) => request<void>('DELETE', `/api/v1/routing-rules/${id}`),

		// Supervisor settings
		getPreferences: () => get<UserPreferences>('/api/v1/preferences'),
		updatePreferences: (body: UpdatePreferencesRequest) =>
			request<UserPreferences>('PATCH', '/api/v1/preferences', body),
		getSupervisorSettings: () => get<SupervisorSettings>('/api/v1/supervisor/settings'),
		getSupervisorQueue: () => get<FleetQueue>('/api/v1/supervisor/queue'),
		updateSupervisorSettings: (body: UpdateSupervisorSettingsRequest) =>
			request<SupervisorSettingsResponse>('PUT', '/api/v1/supervisor/settings', body),

		// API keys (create/revoke require a browser session, not a key)
		listApiKeys: (filters: { run_keys?: RunKeyFilter } = {}) =>
			get<ListResponse<ApiKey>>(`/api/v1/api-keys${query(filters)}`),
		createApiKey: (body: CreateApiKeyRequest) =>
			request<ApiKeyCreated>('POST', '/api/v1/api-keys', body),
		revokeApiKey: (id: string) => request<void>('DELETE', `/api/v1/api-keys/${id}`),

		exportWorkflowPackage: (
			id: string,
			opts: import('./library/types.js').ExportWorkflowPackageOptions = {}
		) => {
			const params = new URLSearchParams();
			if (opts.source_project_id) params.set('source_project_id', opts.source_project_id);
			for (const id of opts.schedule_ids ?? []) params.append('schedule_id', id);
			for (const tier of opts.tiers ?? []) params.append('tier', JSON.stringify(tier));
			if (opts.authoring) params.set('authoring', JSON.stringify(opts.authoring));
			return get<import('./library/types.js').WorkflowPackageDocument>(
				`/api/v1/workflows/${encodeURIComponent(id)}/export${params.size ? '?' + params : ''}`
			);
		},
		prepareWorkflowPackage: (body: import('./library/types.js').PrepareWorkflowPackageRequest) =>
			request<import('./library/types.js').PrepareWorkflowPackageResponse>(
				'POST',
				'/api/v1/library/prepare',
				body
			),
		installWorkflowPackage: (body: import('./library/types.js').WorkflowPackageInstallRequest) =>
			request<import('./library/types.js').WorkflowPackageReceipt>(
				'POST',
				'/api/v1/library/install',
				body
			),
		getWorkflowPackageReceipt: (planId: string) =>
			get<import('./library/types.js').WorkflowPackageReceipt>(
				`/api/v1/library/installs/${encodeURIComponent(planId)}`
			),

		validateLibrary: (body: import('./library/types.js').ValidateLibraryRequest) =>
			request<import('./library/types.js').ValidateLibraryResponse>(
				'POST',
				'/api/v1/library/validate',
				body
			),

		// Library export / import (workflows + context; no tracker data, no secrets)
		exportLibrary: (opts: ExportLibraryOptions = {}) =>
			get<LibraryDocument | import('./library/types.js').LibraryV3Document>(
				`/api/v1/export${query(opts)}`
			),
		/** Plan-then-apply; `dry_run: true` returns the preview the apply follows. */
		importLibrary: (body: ImportLibraryRequest) =>
			request<ImportLibraryResponse>('POST', '/api/v1/import', body)
	};
}

export type ApiClient = ReturnType<typeof createApiClient>;
