import { mkdir, open, rename, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Budget, FULL_LIMITS } from "./ingestion/budget.ts";
import { acquire } from "./ingestion/git.ts";
import { COLLECTIONS, IngestionError } from "./ingestion/model.ts";
import { ingest, type Report } from "./ingestion/runner.ts";

const COMMIT = "15eb09b618ff08a38c4dfee06a91bd139d093f5d";
const directory = ".ingestion/full-dry-run-15eb09b";

async function saveSummary(summaryJson: string): Promise<void> {
	if (Buffer.byteLength(summaryJson) > 1024 * 1024)
		throw new IngestionError(
			"summary_limit",
			"Resumo excede 1 MiB; resumo inicial permanece incompleto",
		);
	await writeFile(`${directory}/summary.tmp`, summaryJson, {
		flag: "wx",
		mode: 0o600,
	});
	await rename(`${directory}/summary.tmp`, `${directory}/summary.json`);
}

async function main() {
	if (process.argv.length !== 2)
		throw new IngestionError(
			"arguments",
			"Comando fixo não aceita opções de escrita, retomada ou referência",
		);
	// Exclusive directory: never overwrite evidence from a previous attempt.
	await mkdir(directory, { mode: 0o700 });
	await writeFile(
		`${directory}/summary.json`,
		`${JSON.stringify({ commit: COMMIT, completed: false, inventoryComplete: false, checkpointAdvanced: false, status: "running_or_interrupted" })}\n`,
		{ flag: "wx", mode: 0o600 },
	);
	const items = await open(`${directory}/items.ndjson`, "wx", 0o600);
	const budget = new Budget();
	let source: Awaited<ReturnType<typeof acquire>> | undefined;
	let report: Report | undefined;
	let error: string | undefined;
	let reportedItems = 0;
	const interrupt = () =>
		budget.stop(
			"interrupted",
			"Interrupção solicitada; nenhum checkpoint avançado",
		);
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", interrupt);
	try {
		await budget.start();
		for (const [path, minimum] of [
			[tmpdir(), 2 * FULL_LIMITS.diskBytes],
			[directory, 2 * FULL_LIMITS.reportBytes],
		] as const) {
			const fs = await statfs(path);
			if (fs.bavail * fs.bsize < minimum)
				throw new IngestionError(
					"disk_preflight",
					"Espaço livre insuficiente para a tentativa limitada",
				);
		}
		console.error(
			JSON.stringify({
				commit: COMMIT,
				limits: FULL_LIMITS,
				reports: directory,
			}),
		);
		source = await acquire(COMMIT, budget);
		if (source.snapshot.commit !== COMMIT)
			throw new IngestionError(
				"invalid_commit",
				"Commit adquirido diverge do autorizado",
			);
		report = await ingest(source.snapshot, {
			budget,
			onInterrupted(partial) {
				report = partial;
			},
			async afterItem(item) {
				try {
					await items.writeFile(`${JSON.stringify(item)}\n`);
					reportedItems++;
				} catch {
					throw new IngestionError(
						"report_io_failed",
						"Falha ao persistir relatório por item",
					);
				}
			},
		});
		await budget.measure();
		if (report.failed || report.conflict) process.exitCode = 1;
	} catch (failure) {
		error = failure instanceof IngestionError ? failure.code : "dry_run_failed";
		process.exitCode = 1;
	} finally {
		await budget.close();
		error ??= budget.failure?.code;
		await source?.dispose();
		await items.close();
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", interrupt);
		const causes: Record<string, number> = {};
		const collections: Record<string, Record<string, number>> = {};
		for (const item of report?.items ?? []) {
			const parts = item.source_path.split("/");
			const collection =
				parts[0] === "federal" && Object.hasOwn(COLLECTIONS, parts[1] ?? "")
					? `federal/${parts[1]}`
					: "@outside_scope";
			collections[collection] ??= {};
			const counts = collections[collection];
			counts[item.outcome] = (counts[item.outcome] ?? 0) + 1;
		}
		for (const item of report?.items ?? [])
			if (item.error_code)
				causes[item.error_code] = (causes[item.error_code] ?? 0) + 1;
		const processed = report?.items.length ?? 0;
		const missingCollections = Object.keys(COLLECTIONS).filter(
			(c) => !collections[`federal/${c}`],
		);
		const reconciled =
			report !== undefined &&
			processed ===
				report.inserted +
					report.updated +
					report.unchanged +
					report.excluded +
					report.removed +
					report.failed +
					report.conflict;
		const summary = {
			...report,
			items: undefined,
			commit: COMMIT,
			dryRun: true,
			completed:
				!error &&
				reconciled &&
				reportedItems === processed &&
				missingCollections.length === 0 &&
				report?.failed === 0 &&
				report?.conflict === 0,
			inventoryComplete: !error && report?.inventoryComplete === true,
			checkpointAdvanced: false,
			error,
			processed,
			reportedItems,
			unprocessed: report?.inventoried ? report.inventoried - processed : null,
			collections,
			missingCollections,
			reconciled,
			causes,
			limits: FULL_LIMITS,
			metrics: budget.metrics(),
		};
		if (!summary.completed) process.exitCode = 1;
		const summaryJson = `${JSON.stringify(summary, null, 2)}\n`;
		await saveSummary(summaryJson);
		console.log(JSON.stringify(summary, null, 2));
	}
}
main().catch((error) => {
	console.error(
		JSON.stringify({
			completed: false,
			inventoryComplete: false,
			checkpointAdvanced: false,
			error: error instanceof IngestionError ? error.code : "dry_run_failed",
		}),
	);
	process.exitCode = 1;
});
