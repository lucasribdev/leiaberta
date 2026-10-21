import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Budget, FULL_LIMITS } from "../../scripts/ingestion/budget.ts";
import type { Database } from "../../scripts/ingestion/database.ts";
import { git } from "../../scripts/ingestion/git.ts";
import { ingest, type Report } from "../../scripts/ingestion/runner.ts";
import { fixture, PATH, snapshot } from "./fixtures.ts";

test("orçamentos exatos de bytes e duração falham fechados", () => {
	for (const kind of ["readBytes", "reportBytes"] as const) {
		const budget = new Budget({ ...FULL_LIMITS, [kind]: 4 });
		budget.consume(kind, 4);
		assert.throws(() => budget.consume(kind, 1), { code: `${kind}_limit` });
		assert.equal(budget[kind], 4);
		assert.equal(budget.controller.signal.aborted, true);
	}
	assert.throws(() => new Budget({ ...FULL_LIMITS, durationMs: 0 }).assert(), {
		code: "duration_limit",
	});
});

test("monitor mede disco e RSS e rejeita excesso; sem aquisição de rede", async () => {
	const directory = await mkdtemp(join(tmpdir(), "la005-budget-"));
	try {
		await writeFile(join(directory, "data"), Buffer.alloc(32));
		const disk = new Budget({ ...FULL_LIMITS, diskBytes: 31 });
		disk.directory = directory;
		await assert.rejects(disk.measure(), { code: "disk_limit" });
		assert.equal(disk.peakDiskBytes, 32);
		const memory = new Budget({ ...FULL_LIMITS, rssBytes: 1 });
		await assert.rejects(memory.measure(), { code: "memory_limit" });
		assert.ok(memory.peakRssBytes > 1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("interrupção de processamento reconcilia prefixo, preserva checkpoint e não declara completude", async () => {
	const other = PATH.replace("lei-10", "lei-11");
	const source = snapshot({ [PATH]: fixture(), [other]: fixture() });
	const budget = new Budget({ ...FULL_LIMITS, readBytes: fixture().length });
	let partial: Report | undefined;
	let reads = 0;
	const original = source.read;
	source.read = async (entry) => {
		reads++;
		return original(entry);
	};
	await assert.rejects(
		ingest(source, {
			budget,
			onInterrupted: (r) => {
				partial = r;
			},
		}),
		{ code: "readBytes_limit" },
	);
	assert.equal(reads, 1);
	assert.ok(partial);
	assert.equal(partial.inventoryComplete, false);
	assert.equal(partial.checkpointAdvanced, false);
	assert.equal(partial.items.length, 1);
	assert.equal(partial.inserted, 1);
	assert.equal(partial.inventoried, 2);
});

test("teto de relatório interrompe sem descartar silenciosamente itens; proíbe banco antes de acesso", async () => {
	const source = snapshot({ [PATH]: fixture() });
	let partial: Report | undefined;
	await assert.rejects(
		ingest(source, {
			budget: new Budget({ ...FULL_LIMITS, reportBytes: 1 }),
			onInterrupted: (r) => {
				partial = r;
			},
		}),
		{ code: "reportBytes_limit" },
	);
	assert.equal(partial?.inventoryComplete, false);
	assert.equal(partial?.items.length, 0);
	assert.equal(partial?.inventoried, 1);
	const db = new Proxy(
		{},
		{
			get() {
				assert.fail("Sem banco");
			},
		},
	) as Database;
	await assert.rejects(ingest(source, { db, budget: new Budget() }), {
		code: "bounded_dry_run_only",
	});
});

test("inventário truncado não é certificado e Git tem teto de saída", async () => {
	const source = snapshot({ [PATH]: fixture() });
	source.inventory = async () => {
		throw new Error("truncated");
	};
	let partial: Report | undefined;
	await assert.rejects(
		ingest(source, {
			budget: new Budget(),
			onInterrupted: (r) => {
				partial = r;
			},
		}),
		{ code: "incomplete_inventory" },
	);
	assert.equal(partial?.inventoryComplete, false);
	await assert.rejects(git(process.cwd(), ["--version"], 1), {
		code: "git_output_limit",
	});
});

test("Git isolado é encerrado com seu grupo no cancelamento, sem rede", async () => {
	const budget = new Budget();
	// Synthetic alias only: exercise a long-lived Git subprocess, never source code.
	const operation = git(
		process.cwd(),
		["-c", "alias.wait=!sleep 30", "wait"],
		undefined,
		budget,
	);
	const pid = budget.childPid;
	assert.ok(pid);
	budget.stop("interrupted", "Teste de interrupção");
	await assert.rejects(operation, { code: "interrupted" });
	assert.equal(budget.childPid, undefined);
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("orçamento preserva classificação e conflitos de identidade do dry-run original", async () => {
	const source = snapshot({
		[PATH]: fixture({ urn: "urn:lex:br:federal:lei:2002-01-10;10" }),
		[PATH.replace("lei-10", "lei-10-copia")]: fixture({
			urn: "urn:lex:br:federal:lei:2002-01-10;10",
		}),
		[PATH.replace("lei-10", "invalido")]: Buffer.from("bad"),
		"constituicao.md": Buffer.from("excluído"),
	});
	const original = await ingest(source);
	const bounded = await ingest(source, { budget: new Budget() });
	assert.deepEqual(bounded, original);
	assert.equal(bounded.inserted, 1);
	assert.equal(bounded.conflict, 1);
	assert.equal(bounded.failed, 1);
	assert.equal(bounded.excluded, 1);
	assert.equal(bounded.inventoried, bounded.items.length);
});
