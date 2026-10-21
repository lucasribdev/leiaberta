import { parseArgs } from "node:util";
import { Database } from "./ingestion/database.ts";
import { acquire } from "./ingestion/git.ts";
import { IngestionError } from "./ingestion/model.ts";
import { archiveTo, ingest } from "./ingestion/runner.ts";

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			ref: { type: "string", default: "main" },
			write: { type: "boolean", default: false },
			"dry-run": { type: "boolean", default: false },
			resume: { type: "string" },
			artifacts: { type: "string" },
			help: { type: "boolean" },
		},
		strict: true,
	});
	if (values.help) {
		console.log(
			"npm run ingest -- [--ref main|COMMIT] [--dry-run]\nEscrita local: --write --artifacts DIRETORIO [--resume UUID]; INGESTION_DATABASE_URL deve permitir SET ROLE law_ingestor.",
		);
		return;
	}
	if (values.write && values["dry-run"])
		throw new IngestionError("arguments", "Escolha dry-run ou escrita");
	if (
		values.resume &&
		(!values.write || !/^[a-f0-9-]{36}$/.test(values.resume))
	)
		throw new IngestionError("arguments", "Retomada exige --write e UUID");
	if (values.write && !values.artifacts)
		throw new IngestionError("arguments", "Escrita exige --artifacts");
	// Validate local credentials before acquiring any source. Dry-run never opens a DB connection.
	const db = values.write
		? await Database.connect(process.env.INGESTION_DATABASE_URL)
		: undefined;
	let source: Awaited<ReturnType<typeof acquire>> | undefined;
	try {
		source = await acquire(values.ref);
		const report = await ingest(source.snapshot, {
			db,
			resume: values.resume,
			archive: values.write ? archiveTo(values.artifacts ?? "") : undefined,
		});
		console.log(JSON.stringify(report, null, 2));
		if (report.failed || report.conflict) process.exitCode = 1;
	} finally {
		await source?.dispose();
		await db?.client.end();
	}
}
main().catch((error) => {
	// Raw driver/Git errors may contain connection strings or source excerpts.
	console.error(
		JSON.stringify({
			error: error instanceof IngestionError ? error.code : "ingestion_failed",
			message:
				error instanceof IngestionError
					? error.message
					: "Falha na ingestão; nenhum segredo é incluído neste diagnóstico",
		}),
	);
	process.exitCode = 1;
});
