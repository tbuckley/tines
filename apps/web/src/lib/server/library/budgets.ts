import type { CompiledQuery } from 'kysely';
import { ApiFail } from '../api/core';

/** Application budgets, subject to native D1 boundary verification before release. */
export const PACKAGE_BATCH_LIMITS = {
	statements: 800,
	parameters_per_statement: 90,
	sql_bytes_per_statement: 90 * 1024,
	value_bytes: 1024 * 1024
} as const;

export interface PackageBatchSize {
	statements: number;
	max_parameters: number;
	max_sql_bytes: number;
	max_value_bytes: number;
}

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
function assertLimit(actual: number, maximum: number, field: string, statement?: number) {
	if (actual > maximum)
		throw new ApiFail(
			422,
			'package_too_large',
			`Package ${field} is ${actual}; maximum is ${maximum}`,
			{
				field,
				actual,
				maximum,
				...(statement === undefined ? {} : { statement })
			}
		);
}

/**
 * Inspect the final complete batch, including receipt, guards, events and final
 * SELECT. Must run before DB.batch; no chunking or partial submission is allowed.
 * Values are measured as UTF-8 bytes (or binary byte length), never JS length.
 */
export function validatePackageBatch(queries: readonly CompiledQuery[]): PackageBatchSize {
	assertLimit(queries.length, PACKAGE_BATCH_LIMITS.statements, 'statements');
	const size: PackageBatchSize = {
		statements: queries.length,
		max_parameters: 0,
		max_sql_bytes: 0,
		max_value_bytes: 0
	};
	queries.forEach((query, statement) => {
		const sqlBytes = bytes(query.sql);
		assertLimit(
			query.parameters.length,
			PACKAGE_BATCH_LIMITS.parameters_per_statement,
			'parameters_per_statement',
			statement
		);
		assertLimit(
			sqlBytes,
			PACKAGE_BATCH_LIMITS.sql_bytes_per_statement,
			'sql_bytes_per_statement',
			statement
		);
		size.max_parameters = Math.max(size.max_parameters, query.parameters.length);
		size.max_sql_bytes = Math.max(size.max_sql_bytes, sqlBytes);
		for (const value of query.parameters) {
			const length =
				typeof value === 'string'
					? bytes(value)
					: value instanceof ArrayBuffer || ArrayBuffer.isView(value)
						? value.byteLength
						: 0;
			assertLimit(length, PACKAGE_BATCH_LIMITS.value_bytes, 'value_bytes', statement);
			size.max_value_bytes = Math.max(size.max_value_bytes, length);
		}
	});
	return size;
}

/** Minimum unavoidable statements: optional automation and possibly reused inputs are excluded. */
export function validatePackageStructure(
	document: import('@tines/shared').WorkflowPackageDocument
): number {
	const statements =
		2 +
		document.workflows.reduce((sum, w) => sum + 2 + w.states.length + w.transitions.length, 0) +
		document.context.reduce((sum, c) => sum + 2 + (c.kind === 'skill' ? c.files.length : 0), 0);
	assertLimit(statements, PACKAGE_BATCH_LIMITS.statements, 'minimum_statements');
	return statements;
}
