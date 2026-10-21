import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseLawBounded } from "./bounded-parser.ts";
import type { Database, Item, Law, Run } from "./database.ts";
import {
	CONFIG_HASH,
	type Entry,
	IngestionError,
	LIMITS,
	PARSER_VERSION,
	projectionHash,
	REPOSITORY,
	type Snapshot,
	scope,
	sha256,
} from "./model.ts";

export interface Report {
	commit: string;
	base: string | null;
	runId?: string;
	dryRun: boolean;
	inventoryComplete: boolean;
	checkpointAdvanced: boolean;
	inventoried: number;
	inserted: number;
	updated: number;
	unchanged: number;
	excluded: number;
	removed: number;
	failed: number;
	conflict: number;
	items: Item[];
}
export interface Options {
	db?: Database;
	resume?: string;
	parserVersion?: string;
	configHash?: string;
	archive?: (bytes: Buffer) => Promise<string>;
	afterItem?: (item: Item) => Promise<void>;
}
export function archiveTo(
	directory: string,
): (bytes: Buffer) => Promise<string> {
	return async (bytes) => {
		const hash = sha256(bytes);
		const path = join(directory, hash);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		try {
			await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (sha256(await readFile(path)) !== hash)
				throw new IngestionError(
					"artifact_integrity",
					"Artefato existente divergente",
				);
		}
		return `sha256:${hash}`;
	};
}
function conflict(message: string): never {
	throw new IngestionError("identity_conflict", message);
}
function validInventory(entries: Entry[]): void {
	if (
		entries.length > LIMITS.files ||
		new Set(entries.map((e) => e.path)).size !== entries.length
	)
		throw new IngestionError(
			"incomplete_inventory",
			"Inventário inválido ou duplicado",
		);
	for (const entry of entries) {
		scope(entry.path);
		if (
			!/^[a-f0-9]{40}$/.test(entry.blob) ||
			!Number.isSafeInteger(entry.size) ||
			entry.size < 0
		)
			throw new IngestionError("invalid_tree", "Inventário Git inválido");
	}
}
export async function ingest(
	snapshot: Snapshot,
	options: Options = {},
): Promise<Report> {
	const { db } = options;
	if (db && !options.archive)
		throw new IngestionError(
			"archive_required",
			"Escrita exige arquivo de bytes originais",
		);
	const parser = options.parserVersion ?? PARSER_VERSION;
	const config = options.configHash ?? CONFIG_HASH;
	const report: Report = {
		commit: snapshot.commit,
		base: null,
		dryRun: !db,
		inventoryComplete: false,
		checkpointAdvanced: false,
		inventoried: 0,
		inserted: 0,
		updated: 0,
		unchanged: 0,
		excluded: 0,
		removed: 0,
		failed: 0,
		conflict: 0,
		items: [],
	};
	let run: Run | undefined;
	let failure: unknown;
	if (db) await db.lock();
	try {
		const checkpoint = await db?.checkpoint();
		report.base = checkpoint?.commit_sha ?? null;
		run = await db?.start(
			snapshot.commit,
			report.base,
			parser,
			config,
			!checkpoint
				? "full"
				: checkpoint.parser_version !== parser ||
						checkpoint.config_hash !== config
					? "reprocess"
					: "incremental",
			options.resume,
		);
		report.runId = run?.id;
		let entries: Entry[];
		try {
			entries = await snapshot.inventory(snapshot.commit);
			validInventory(entries);
		} catch {
			if (db && run) {
				await db.record(run.id, {
					source_path: "@inventory",
					operation: "reprocess",
					outcome: "failed",
					error_code: "incomplete_inventory",
					error_message: "Inventário não concluído; retome o mesmo snapshot",
				});
				await db.finish(run, report, false, false);
			}
			throw new IngestionError(
				"incomplete_inventory",
				"Inventário não concluído; checkpoint preservado",
			);
		}
		report.inventoryComplete = true;
		const pending = (await db?.pending()) ?? [];
		if (db && run) {
			const previous = (await db.items(run.id)).find(
				(i) => i.source_path === "@inventory",
			);
			if (
				previous?.outcome === "failed" ||
				pending.some((i) => i.source_path === "@inventory")
			)
				await db.record(run.id, {
					source_path: "@inventory",
					operation: "reprocess",
					outcome: "excluded",
					source_metadata: { reason: "inventory_recovered" },
				});
		}
		const target = new Map(entries.map((e) => [e.path, e]));
		const laws = (await db?.laws()) ?? [];
		const paths = (await db?.paths()) ?? [];
		const done = new Map(
			(db && run ? await db.items(run.id) : []).map((i) => [i.source_path, i]),
		);
		// Inventory is complete before any removals or identity decisions. A base checkout is
		// unnecessary: committed laws/path history are the durable successfully applied base.
		const removed = laws.filter(
			(l) =>
				!l.source_removed_at &&
				!target.has(l.source_path) &&
				scope(l.source_path) === null,
		);
		const removalManifest =
			run?.counters?.removals ??
			removed.map((l) => ({ path: l.source_path, id: l.id }));
		if (db && run && !run.counters?.removals)
			await db.client.query(
				"update ingestion_private.runs set counters=$2 where id=$1",
				[run.id, JSON.stringify({ removals: removalManifest })],
			);
		const tasks: (Entry & { removal?: Law; pending?: Item })[] = [
			...entries,
			...removalManifest.map((m) => {
				const law = laws.find((l) => l.id === m.id);
				if (!law)
					throw new IngestionError(
						"resume_identity",
						"Lei do manifesto ausente",
					);
				return {
					path: m.path,
					blob: law.source_blob_sha,
					size: 0,
					mode: "100644",
					removal: law,
				};
			}),
		];
		for (const item of pending)
			if (
				item.source_path !== "@inventory" &&
				!tasks.some((e) => e.path === item.source_path)
			)
				tasks.push({
					path: item.source_path,
					blob: item.blob_sha ?? "0".repeat(40),
					mode: "100644",
					size: 0,
					pending: item,
				});
		report.inventoried = tasks.length;
		for (const entry of tasks) {
			const previous = done.get(entry.path);
			if (
				previous &&
				!["failed", "conflict"].includes(previous.outcome) &&
				!pending.some((i) => i.source_path === entry.path)
			) {
				report.items.push(previous);
				continue;
			}
			const item: Item = {
				source_path: entry.path,
				blob_sha: entry.blob,
				operation: entry.removal ? "remove" : "reprocess",
				outcome: "failed",
			};
			let recorded = false;
			try {
				if (entry.pending)
					conflict("Falha anterior em caminho ausente exige revisão explícita");
				const exclusion = scope(entry.path);
				if (exclusion) {
					item.outcome = "excluded";
					item.source_metadata = { reason: exclusion };
				} else if (entry.removal) {
					item.law_id = entry.removal.id;
					// A validated rename already closed this path in the same run.
					const current = laws.find((l) => l.id === entry.removal?.id);
					if (current?.source_path === entry.path) {
						if (db && run) {
							const runId = run.id;
							await db.transaction(async () => {
								await db.remove(current, snapshot.commit);
								item.outcome = "removed";
								await db.record(runId, item);
							});
						} else item.outcome = "removed";
					} else {
						item.outcome = "removed";
						item.source_metadata = {
							reason: "validated_rename",
							law_id: current?.id,
						};
					}
					if (db && run && item.source_metadata) await db.record(run.id, item);
					recorded = true;
				} else {
					if (entry.mode !== "100644")
						throw new IngestionError(
							"unsafe_blob",
							"Symlink, executável ou submódulo rejeitado",
						);
					let law = laws.find((l) => l.source_path === entry.path);
					const latest = law && db ? await db.latest(law.id) : undefined;
					if (
						law &&
						!law.source_removed_at &&
						law.source_blob_sha === entry.blob &&
						latest?.sourceHash === law.source_hash &&
						latest?.blobSha === entry.blob &&
						latest?.parserVersion === parser &&
						latest?.configHash === config &&
						latest?.projectionHash === projectionHash(law)
					) {
						item.outcome = "unchanged";
						item.law_id = law.id;
						item.source_hash = law.source_hash;
						item.artifact_reference = `sha256:${law.source_hash}`;
						item.source_metadata = latest;
					} else {
						const bytes = await snapshot.read(entry);
						item.source_hash = sha256(bytes);
						if (options.archive)
							item.artifact_reference = await options.archive(bytes);
						const parsed = await parseLawBounded(bytes, entry.path);
						const p = parsed.projection;
						item.source_metadata = {
							parserVersion: parser,
							configHash: config,
							projectionHash: projectionHash(p),
							metadata: p.source_metadata,
							warnings: parsed.warnings,
						};
						const byUrn = p.source_urn
							? laws.find(
									(l) =>
										l.source_urn === p.source_urn ||
										l.source_id === p.source_urn,
								)
							: undefined;
						if (law) {
							if (
								law.source_removed_at ||
								paths.some((h) => h.source_path === entry.path && h.closed_at)
							)
								conflict("Caminho histórico reutilizado exige revisão");
							if (byUrn && byUrn.id !== law.id)
								conflict("URN pertence a outra norma");
							for (const key of [
								"law_type",
								"number",
								"year",
								"enactment_date",
							] as const)
								if (law[key] !== p[key])
									conflict("Identidade do caminho diverge da norma publicada");
							if (law.source_urn && law.source_urn !== p.source_urn)
								conflict("Correção ou remoção de URN exige revisão");
						} else {
							if (paths.some((h) => h.source_path === entry.path))
								conflict("Caminho reservado pelo histórico");
							const candidates = removed.filter(
								(l) => l.source_blob_sha === entry.blob,
							);
							const targetCopies = entries.filter(
								(e) => e.blob === entry.blob && scope(e.path) === null,
							);
							if (
								candidates.length === 1 &&
								targetCopies.length === 1 &&
								(!byUrn || byUrn.id === candidates[0].id)
							) {
								law = laws.find((l) => l.id === candidates[0].id);
								item.previous_path = law?.source_path;
								item.operation = "rename";
							} else if (
								byUrn ||
								candidates.length ||
								laws.some(
									(l) =>
										l.law_type === p.law_type &&
										l.number === p.number &&
										l.year === p.year &&
										l.enactment_date === p.enactment_date,
								)
							)
								conflict(
									"Possível renome ou identidade duplicada sem prova suficiente",
								);
						}
						item.operation = item.previous_path
							? "rename"
							: law
								? "modify"
								: "add";
						const marker = law && db ? await db.latest(law.id) : undefined;
						const unchanged =
							law !== undefined &&
							!law.source_removed_at &&
							law.source_path === entry.path &&
							law.source_hash === parsed.hash &&
							marker?.parserVersion === parser &&
							marker?.configHash === config &&
							marker?.projectionHash === projectionHash(p) &&
							projectionHash(law) === projectionHash(p);
						if (unchanged && law) {
							item.outcome = "unchanged";
							item.law_id = law.id;
						} else {
							item.outcome = law ? "updated" : "inserted";
							const provenance = {
								source_path: entry.path,
								source_url: `${REPOSITORY}/blob/${snapshot.commit}/${entry.path}`,
								source_commit_sha: snapshot.commit,
								source_blob_sha: entry.blob,
								source_hash: parsed.hash,
								source_removed_at: null,
								imported_at: new Date().toISOString(),
								...(!law
									? {
											source_id:
												p.source_urn ?? `ctresb/leis:path:${entry.path}`,
										}
									: {}),
							};
							let saved: Law;
							if (db && run) {
								const prior = law;
								const runId = run.id;
								saved = await db.transaction(async () => {
									if (prior && item.previous_path)
										await db.closePath(prior, snapshot.commit);
									const result = await db.save(p, provenance, prior);
									if (!prior || item.previous_path)
										await db.openPath(result, snapshot.commit);
									item.law_id = result.id;
									await db.record(runId, item);
									return result;
								});
							} else
								saved = {
									...p,
									...provenance,
									id: law?.id ?? randomUUID(),
									source_id: law?.source_id ?? String(provenance.source_id),
								} as Law;
							const index = laws.findIndex((l) => l.id === saved.id);
							if (index < 0) laws.push(saved);
							else laws[index] = saved;
							if (db) item.law_id = saved.id;
							recorded = true;
						}
					}
				}
			} catch (error) {
				if (item.law_id && !laws.some((l) => l.id === item.law_id))
					delete item.law_id;
				const code =
					error instanceof IngestionError ? error.code : "processing_failed";
				item.outcome = code === "identity_conflict" ? "conflict" : "failed";
				item.error_code = code;
				item.error_message =
					error instanceof IngestionError
						? error.message
						: "Falha de aquisição, artefato ou transação; versão pública preservada";
			}
			if (db && run && !recorded) await db.record(run.id, item);
			report.items.push(item);
			await options.afterItem?.(item);
		}
		for (const item of report.items) report[item.outcome]++;
		if (report.items.length !== report.inventoried)
			throw new IngestionError(
				"reconciliation",
				"Contadores não reconciliados",
			);
		if (db && run) {
			report.checkpointAdvanced = report.failed + report.conflict === 0;
			await db.finish(
				run,
				{ ...report, items: undefined, removals: removalManifest },
				true,
				report.failed + report.conflict === 0,
			);
		}
		return report;
	} catch (error) {
		failure = error;
		if (db && run)
			await db.client
				.query(
					"update ingestion_private.runs set status='failed',finished_at=greatest(statement_timestamp(),started_at) where id=$1 and status='running'",
					[run.id],
				)
				.catch(() => {});
		throw error;
	} finally {
		if (db)
			await db.unlock().catch((error) => {
				if (!failure) throw error;
			});
	}
}
