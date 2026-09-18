type D1Database = Env['DB'];
type D1PreparedStatement = ReturnType<D1Database['prepare']>;

/** Local scale harness only. Observe the native result before kysely-d1 drops
 * D1 metadata. No additional SQL is executed and production leaves this off. */
export function traceUsageScaleDb(database: D1Database): D1Database {
	return new Proxy(database, {
		get(target, property) {
			if (property !== 'prepare') {
				const value = Reflect.get(target, property);
				return typeof value === 'function' ? value.bind(target) : value;
			}
			return (query: string) => {
				const wrap = (statement: D1PreparedStatement, parameters: unknown[]): D1PreparedStatement =>
					new Proxy(statement, {
						get(stmt, method) {
							if (method === 'bind')
								return (...values: unknown[]) => wrap(stmt.bind(...values), values);
							if (method === 'all')
								return async () => {
									const result = await stmt.all();
									// Only local ledger fixtures need compiled SQL/bindings. Do not
									// record authentication parameters or returned field contents.
									const ledger = query.includes('from "agent_run"');
									const statsEvent = query.includes('from "event"') && query.includes('"type" in');
									const ordered = ledger && query.includes('order by');
									const idsHash = ordered
										? Array.from(
												new Uint8Array(
													await crypto.subtle.digest(
														'SHA-256',
														new TextEncoder().encode(
															JSON.stringify(result.results.map((row) => row.id))
														)
													)
												),
												(byte) => byte.toString(16).padStart(2, '0')
											).join('')
										: undefined;
									console.log(
										'[USAGE_SCALE_SQL]' +
											JSON.stringify({
												rows_read: result.meta.rows_read,
												ids_sha256: idsHash,
												duration_ms: result.meta.duration,
												returned_rows: result.results.length,
												...(ledger || statsEvent
													? {
															sql: query,
															parameters,
															response_bytes: new TextEncoder().encode(
																JSON.stringify(result.results)
															).length
														}
													: {})
											})
									);
									return result;
								};
							const value = Reflect.get(stmt, method);
							return typeof value === 'function' ? value.bind(stmt) : value;
						}
					});
				return wrap(target.prepare(query), []);
			};
		}
	});
}
