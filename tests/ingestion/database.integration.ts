import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import pg from "pg";
import {
	Database,
	databaseTypes,
	localDatabaseUrl,
} from "../../scripts/ingestion/database.ts";
import { archiveTo, ingest } from "../../scripts/ingestion/runner.ts";
import { fixture, PATH, RENAMED, snapshot, URN } from "./fixtures.ts";

// All role grants, operational rows and public projections are rolled back. The
// runner's individual transactions become savepoints inside the test transaction.
class TestDatabase extends Database {
	sequence = 0;
	override async transaction<T>(fn: () => Promise<T>): Promise<T> {
		const name = `unit_${++this.sequence}`;
		await this.client.query(`savepoint ${name}`);
		try {
			const result = await fn();
			await this.client.query(`release savepoint ${name}`);
			return result;
		} catch (error) {
			await this.client.query(`rollback to savepoint ${name}`);
			await this.client.query(`release savepoint ${name}`);
			throw error;
		}
	}
}

test("runner PostgreSQL com law_ingestor: replay, identidade, falhas, retomada e checkpoints", async (t) => {
	const client = new pg.Client({
		connectionString: localDatabaseUrl(process.env.INGESTION_TEST_DATABASE_URL),
		types: databaseTypes,
	});
	await client.connect();
	const directory = await mkdtemp(join(tmpdir(), "la005-test-"));
	const db = new TestDatabase(client);
	const options = { db, archive: archiveTo(directory) };
	try {
		await client.query("begin");
		await client.query("grant law_ingestor to postgres with set true");
		await client.query("set local role law_ingestor");
		assert.equal(
			(await client.query("select current_user as role")).rows[0].role,
			"law_ingestor",
		);
		assert.equal(
			(await client.query("select count(*)::int n from ingestion_private.runs"))
				.rows[0].n,
			0,
			"local harness requires no existing ingestion runs",
		);

		await t.test(
			"ordenação e encerramento resistem à regressão do relógio",
			async () => {
				await client.query("savepoint clock_scenario");
				const run = await db.start(
					"a".repeat(40),
					null,
					"clock",
					"b".repeat(64),
					"full",
				);
				await client.query(
					"update ingestion_private.runs set started_at='2099-01-01' where id=$1",
					[run.id],
				);
				await client.query(
					"insert into ingestion_private.items(run_id,source_path,operation,outcome,error_code,error_message,attempt,recorded_at) values($1,'clock.md','add','failed','clock','Synthetic failure',1,'2099-01-01')",
					[run.id],
				);
				await db.record(run.id, {
					source_path: "clock.md",
					operation: "reprocess",
					outcome: "excluded",
				});
				assert.deepEqual(await db.pending(), []);
				await db.finish(run, {}, true, true);
				const ended = (
					await client.query(
						"select finished_at >= started_at as valid from ingestion_private.runs where id=$1",
						[run.id],
					)
				).rows[0];
				assert.equal(ended.valid, true);
				await client.query("rollback to savepoint clock_scenario");
			},
		);
		await t.test(
			"inserção, replay sem leitura de blob e timestamps estáveis",
			async () => {
				const initial = await ingest(snapshot({ [PATH]: fixture() }), options);
				assert.equal(initial.inserted, 1);
				assert.equal(initial.checkpointAdvanced, true);
				const before = (await db.laws()).find((l) => l.source_path === PATH);
				const same = snapshot({ [PATH]: fixture() }, "b");
				const replay = await ingest(same, options);
				assert.equal(replay.unchanged, 1);
				assert.deepEqual(same.reads, []);
				assert.deepEqual(
					(await db.laws()).find((l) => l.id === before?.id),
					before,
				);
			},
		);
		await t.test(
			"atualização e URN tardia preservam UUID e source_id inicial; parser/config reprocessam",
			async () => {
				const before = (await db.laws())[0];
				const result = await ingest(
					snapshot(
						{ [PATH]: fixture({ urn: URN, ementa: "Texto corrigido" }) },
						"c",
					),
					options,
				);
				assert.equal(result.updated, 1);
				const after = (await db.laws())[0];
				assert.equal(after.id, before.id);
				assert.equal(after.source_id, before.source_id);
				assert.equal(after.source_urn, URN);
				const reprocessed = await ingest(
					snapshot(
						{ [PATH]: fixture({ urn: URN, ementa: "Texto corrigido" }) },
						"c",
					),
					{ ...options, parserVersion: "test-v2" },
				);
				assert.equal(reprocessed.updated, 1);
				const configChanged = await ingest(
					snapshot(
						{ [PATH]: fixture({ urn: URN, ementa: "Texto corrigido" }) },
						"c",
					),
					{ ...options, configHash: "f".repeat(64) },
				);
				assert.equal(configChanged.updated, 1);
			},
		);
		await t.test(
			"rollback de lei+caminho+item e falha durável; retomada resolve tentativa",
			async () => {
				const newPath = "federal/leis-ordinarias/2002/lei-20.md";
				const files = {
					[PATH]: fixture({ urn: URN, ementa: "Texto corrigido" }),
					[newPath]: fixture({ numero: "20", titulo: "Lei sintética nº 20" }),
				};
				const original = db.openPath.bind(db);
				db.openPath = async () => {
					throw new Error("synthetic rollback");
				};
				const failed = await ingest(snapshot(files, "d"), options);
				assert.equal(failed.failed, 1);
				assert.equal(failed.checkpointAdvanced, false);
				assert.equal(
					(await db.laws()).filter((l) => l.source_path === newPath).length,
					0,
				);
				db.openPath = original;
				const recovered = await ingest(snapshot(files, "d"), {
					...options,
					resume: failed.runId,
				});
				assert.equal(recovered.inserted, 1);
				assert.equal(recovered.failed, 0);
				assert.equal(recovered.checkpointAdvanced, true);
				assert.equal(
					(
						await client.query(
							"select count(*)::int n from ingestion_private.items where run_id=$1 and source_path=$2",
							[failed.runId, newPath],
						)
					).rows[0].n,
					2,
				);
			},
		);

		await t.test(
			"projeção divergente força atualização mesmo com hash e blob iguais",
			async () => {
				const law = (await db.laws()).find((l) => l.source_path === PATH);
				assert.ok(law);
				await client.query("update public.laws set summary=$2 where id=$1", [
					law.id,
					"Divergência sintética",
				]);
				const files = {
					[PATH]: fixture({ urn: URN, ementa: "Texto corrigido" }),
					"federal/leis-ordinarias/2002/lei-20.md": fixture({
						numero: "20",
						titulo: "Lei sintética nº 20",
					}),
				};
				const report = await ingest(snapshot(files, "d"), options);
				assert.equal(report.updated, 1);
				assert.equal(
					(await db.laws()).find((l) => l.id === law.id)?.summary,
					"Texto corrigido",
				);
			},
		);

		await t.test(
			"hash divergente no banco impede atalho de replay",
			async () => {
				const law = (await db.laws()).find((l) => l.source_path === PATH);
				assert.ok(law);
				await client.query(
					"update public.laws set source_hash=$2 where id=$1",
					[law.id, "f".repeat(64)],
				);
				const files = {
					[PATH]: fixture({ urn: URN, ementa: "Texto corrigido" }),
					"federal/leis-ordinarias/2002/lei-20.md": fixture({
						numero: "20",
						titulo: "Lei sintética nº 20",
					}),
				};
				const report = await ingest(snapshot(files, "d"), options);
				assert.equal(report.updated, 1);
				assert.equal(
					(await db.laws()).find((l) => l.id === law.id)?.source_hash,
					law.source_hash,
				);
			},
		);
		await t.test(
			"renome com conteúdo alterado exige revisão sem fusão",
			async () => {
				await client.query("savepoint changed_rename");
				const before = await db.checkpoint();
				const count = (await db.laws()).length;
				const report = await ingest(
					snapshot(
						{ [RENAMED]: fixture({ urn: URN, ementa: "Conteúdo divergente" }) },
						"e",
					),
					options,
				);
				assert.equal(report.conflict, 1);
				assert.equal((await db.laws()).length, count);
				assert.deepEqual(await db.checkpoint(), before);
				await client.query("rollback to savepoint changed_rename");
			},
		);
		await t.test(
			"retomada após renome usa manifesto durável das remoções",
			async () => {
				await client.query("savepoint rename_resume");
				const files = {
					[RENAMED]: fixture({ urn: URN, ementa: "Texto corrigido" }),
				};
				await assert.rejects(
					ingest(snapshot(files, "e"), {
						...options,
						afterItem: async () => {
							throw new Error("interruption after rename");
						},
					}),
					/interruption/,
				);
				const run = (
					await client.query(
						"select id from ingestion_private.runs order by execution_sequence desc limit 1",
					)
				).rows[0];
				const report = await ingest(snapshot(files, "e"), {
					...options,
					resume: run.id,
				});
				assert.equal(report.updated, 1);
				assert.equal(report.removed, 2);
				assert.equal(report.inventoried, 3);
				assert.equal(report.checkpointAdvanced, true);
				await client.query("rollback to savepoint rename_resume");
			},
		);
		await t.test(
			"renome exato conserva UUID; remoção não exclui nem infere vigência",
			async () => {
				const prior = (await db.laws()).find((l) => l.source_path === PATH);
				const result = await ingest(
					snapshot(
						{ [RENAMED]: fixture({ urn: URN, ementa: "Texto corrigido" }) },
						"e",
					),
					options,
				);
				assert.equal(result.updated, 1);
				assert.equal(result.removed, 2);
				const law = (await db.laws()).find((l) => l.id === prior?.id);
				assert.equal(law?.source_path, RENAMED);
				assert.equal(law?.legal_status, "unknown");
				assert.equal(law?.source_removed_at, null);
				const count = (await db.laws()).length;
				const removed = await ingest(snapshot({}, "f"), options);
				assert.equal(removed.removed, 1);
				assert.equal((await db.laws()).length, count);
				assert.equal(
					(await db.laws()).find((l) => l.id === prior?.id)?.legal_status,
					"unknown",
				);
			},
		);
		await t.test(
			"caminho reutilizado e URN duplicada exigem revisão; falha persistente bloqueia cursor",
			async () => {
				await client.query("savepoint conflict_scenario");
				const before = await db.checkpoint();
				const reused = await ingest(
					snapshot(
						{
							[PATH]: fixture({ numero: "99", titulo: "Lei sintética nº 99" }),
						},
						"a",
					),
					options,
				);
				assert.equal(reused.conflict, 1, JSON.stringify(reused.items));
				assert.deepEqual(await db.checkpoint(), before);
				const again = await ingest(
					snapshot(
						{
							[PATH]: fixture({ numero: "99", titulo: "Lei sintética nº 99" }),
						},
						"a",
					),
					{ ...options, resume: reused.runId },
				);
				assert.equal(again.conflict, 1);
				assert.deepEqual(await db.checkpoint(), before);
				const duplicate = await ingest(
					snapshot(
						{
							"federal/leis-ordinarias/2002/duplicate.md": fixture({
								urn: URN,
							}),
						},
						"b",
					),
					options,
				);
				assert.ok(duplicate.conflict >= 1);
				assert.deepEqual(await db.checkpoint(), before);
				await client.query("rollback to savepoint conflict_scenario");
			},
		);

		await t.test(
			"pendência fora do próximo inventário continua bloqueando; correção posterior resolve",
			async () => {
				await client.query("savepoint absent_failure");
				const path = "federal/leis-ordinarias/2002/lei-50.md";
				const before = await db.checkpoint();
				const first = await ingest(
					snapshot({ [path]: Buffer.from("malformed") }, "a"),
					options,
				);
				assert.equal(first.failed, 1);
				const next = await ingest(snapshot({}, "b"), options);
				assert.equal(next.conflict, 1);
				assert.deepEqual(await db.checkpoint(), before);
				const corrected = await ingest(
					snapshot(
						{
							[path]: fixture({ numero: "50", titulo: "Lei sintética nº 50" }),
						},
						"c",
					),
					options,
				);
				assert.equal(corrected.inserted, 1);
				assert.equal(corrected.checkpointAdvanced, true);
				await client.query("rollback to savepoint absent_failure");
			},
		);
		await t.test(
			"inventário incompleto e retomada; falha sai do inventário somente após resolução durável",
			async () => {
				const broken = snapshot({}, "c");
				broken.inventory = async () => {
					throw new Error("truncated");
				};
				const before = await db.checkpoint();
				await assert.rejects(ingest(broken, options), /Inventário/);
				assert.deepEqual(await db.checkpoint(), before);
				const run = (
					await client.query(
						"select id from ingestion_private.runs where target_commit_sha=$1 order by execution_sequence desc limit 1",
						["c".repeat(40)],
					)
				).rows[0];
				const resumed = await ingest(snapshot({}, "c"), {
					...options,
					resume: run.id,
				});
				assert.equal(resumed.checkpointAdvanced, true);
			},
		);
		await t.test(
			"interrupção e concorrência impedem avanço; retomada ignora itens resolvidos",
			async () => {
				const files = {
					"federal/leis-ordinarias/2002/lei-30.md": fixture({
						numero: "30",
						titulo: "Lei sintética nº 30",
					}),
					"federal/leis-ordinarias/2002/lei-40.md": fixture({
						numero: "40",
						titulo: "Lei sintética nº 40",
					}),
				};
				const before = await db.checkpoint();
				await assert.rejects(
					ingest(snapshot(files, "d"), {
						...options,
						afterItem: async () => {
							throw new Error("interruption");
						},
					}),
					/interruption/,
				);
				assert.deepEqual(await db.checkpoint(), before);
				const run = (
					await client.query(
						"select id from ingestion_private.runs order by execution_sequence desc limit 1",
					)
				).rows[0];
				const resumed = await ingest(snapshot(files, "d"), {
					...options,
					resume: run.id,
				});
				assert.equal(resumed.checkpointAdvanced, true);
				assert.equal(
					(await db.laws()).filter((l) => Object.hasOwn(files, l.source_path))
						.length,
					2,
				);
				const other = new pg.Client({
					connectionString: localDatabaseUrl(
						process.env.INGESTION_TEST_DATABASE_URL,
					),
				});
				await other.connect();
				try {
					await db.lock();
					await assert.rejects(new Database(other).lock(), /Outro importador/);
				} finally {
					await db.unlock();
					await other.end();
				}
			},
		);
	} finally {
		await client.query("rollback");
		await client.end();
		await rm(directory, { recursive: true, force: true });
	}
});
