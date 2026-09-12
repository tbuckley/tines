// Local harness sidecar: EXPLAIN only, on the harness's local D1 fixture.
// Never part of the application Worker or deployed routes.
export default {
	async fetch(request, env) {
		if (request.method !== 'POST') return new Response('local EXPLAIN probe');
		const { sql, parameters } = await request.json();
		if (!sql.startsWith('select ') || !sql.includes('from "agent_run"') || sql.includes(';'))
			return new Response('Expected one ledger SELECT', { status: 400 });
		return Response.json(
			await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
				.bind(...parameters)
				.all()
		);
	}
};
