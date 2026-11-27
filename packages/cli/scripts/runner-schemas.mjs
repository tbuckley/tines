// Run from packages/cli. The shared API types own both payload formats.
import { readFileSync, writeFileSync } from 'node:fs';
import { createGenerator } from 'ts-json-schema-generator';
import prettier from 'prettier';

for (const [file, type, path] of [
	['runner-assignment', 'RunnerAssignment', '../shared/src/types.ts'],
	['runner-event', 'RunnerExecutionEvent', '../shared/src/runner-execute.ts']
]) {
	const schema = createGenerator({
		path,
		type,
		tsconfig: 'tsconfig.json',
		skipTypeCheck: true,
		additionalProperties: true,
		jsDoc: 'none',
		encodeRefs: false
	}).createSchema(type);
	schema.$schema = 'https://json-schema.org/draft/2020-12/schema';
	// Each event has a unique literal type tag.
	if (type === 'RunnerAssignment') {
		schema.definitions.AgentRun.properties.id.pattern = '^[a-zA-Z0-9_-]+$';
		schema.definitions.RunnerAssignment.properties.run_key.minLength = 1;
		schema.definitions.RunnerAssignment.properties.timeout_minutes.exclusiveMinimum = 0;
	} else {
		const union = schema.definitions[type];
		union.oneOf = union.anyOf;
		delete union.anyOf;
	}
	const filename = `schemas/${file}.schema.json`;
	const json = await prettier.format(
		JSON.stringify(schema)
			.replaceAll('#/definitions/', '#/$defs/')
			.replace('"definitions":', '"$defs":'),
		{
			...(await prettier.resolveConfig(filename)),
			filepath: filename
		}
	);
	if (process.argv.includes('--check')) {
		if (readFileSync(filename, 'utf8') !== json)
			throw new Error(`Regenerate ${filename} with pnpm runner:schemas`);
	} else writeFileSync(filename, json);
}
