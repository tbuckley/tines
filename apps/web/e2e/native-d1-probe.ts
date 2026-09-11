interface Env {
	DB: D1Database;
}

/** Test-only Worker used to measure the D1 binding itself, outside app validation. */
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		try {
			const { sql, parameters = [] } = (await request.json()) as {
				sql: string;
				parameters?: unknown[];
			};
			const result = await env.DB.prepare(sql)
				.bind(...parameters)
				.run();
			return Response.json({ success: true, result });
		} catch (error) {
			return Response.json(
				{ success: false, error: error instanceof Error ? error.message : String(error) },
				{ status: 422 }
			);
		}
	}
} satisfies ExportedHandler<Env>;
