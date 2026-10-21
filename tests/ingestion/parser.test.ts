import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { localDatabaseUrl } from "../../scripts/ingestion/database.ts";
import {
	COLLECTIONS,
	LIMITS,
	scope,
	sha256,
} from "../../scripts/ingestion/model.ts";
import { parseLaw } from "../../scripts/ingestion/parser.ts";
import { ingest } from "../../scripts/ingestion/runner.ts";
import { fixture, PATH, snapshot, URN } from "./fixtures.ts";

test("parse preserva metadados desconhecidos, texto seguro, datas e hash dos bytes", () => {
	const bytes = fixture({
		urn: URN,
		extra: { nested: ["§", 1, null] },
		forca_legal_fonte: '{"status":"NotInForce"}',
		data_publicacao: "2002-01-11",
	});
	const result = parseLaw(bytes, PATH);
	assert.equal(result.hash, createHash("sha256").update(bytes).digest("hex"));
	assert.equal(result.projection.enactment_date, "2002-01-10");
	assert.equal(result.projection.publication_date, "2002-01-11");
	assert.deepEqual(
		(result.projection.source_metadata as Record<string, unknown>).extra,
		{ nested: ["§", 1, null] },
	);
	assert.deepEqual(result.warnings, ["unknown_metadata:extra"]);
	const bom = Buffer.concat([
		Buffer.from([239, 187, 191]),
		Buffer.from(bytes.toString().replaceAll("\n", "\r\n")),
	]);
	assert.equal(parseLaw(bom, PATH).projection.title, result.projection.title);
	assert.notEqual(sha256(bom), result.hash);
});
test("números ausentes e complementos; ano sem data", () => {
	for (const numero of [undefined, null, "", "14-A", "25170-A", "1463-2"])
		assert.equal(
			parseLaw(
				fixture({
					numero,
					titulo: `Lei sintética ${numero ? `nº ${numero}` : "sem número"}`,
				}),
				PATH,
			).projection.number,
			numero || null,
		);
	assert.equal(
		parseLaw(fixture({ data: null, ano: 2002 }), PATH).projection
			.enactment_date,
		null,
	);
	assert.equal(
		parseLaw(
			fixture({
				numero: "",
				titulo: "Lei sintética sem número",
				urn: "urn:lex:br:federal:lei:2002-01-10;seq-sf-2",
			}),
			PATH,
		).projection.number,
		null,
	);
});
test("YAML, codificação, incompletude e divergências rejeitados", () => {
	const base = fixture();
	const bad = [
		Buffer.from([0xff]),
		Buffer.concat([base, Buffer.from([0])]),
		Buffer.from(base.toString().replace("---\n", "---\ntitulo: duplicado\n")),
		Buffer.from(base.toString().replace("---\n", "---\nx: &x [1]\ny: *x\n")),
		Buffer.from(
			base.toString().replace("---\n", "---\nx: !!js/function foo\n"),
		),
		Buffer.from(
			base
				.toString()
				.replace("---\n", `---\nx: ${"[".repeat(40)}0${"]".repeat(40)}\n`),
		),
		fixture({ data: "2002-02-30" }),
		fixture({ ano: 2001 }),
		fixture({ urn: URN.replace(";10", ";11") }),
		fixture({ urn: URN.replace("federal", "senado.federal") }),
		fixture({ tipo: "Decreto" }),
		fixture({ uf: "SP" }),
		fixture({ identidade_pendente_revisao: true }),
		fixture({ fonte: "https://normas.leg.br.attacker.invalid/" }),
		fixture({ fonte: "https://user:secret@normas.leg.br/" }),
		fixture({}, "# Lei sintética nº 10\n"),
		fixture(
			{},
			"# Outro título\nTexto suficientemente longo para ser rejeitado.",
		),
		fixture({}, "# Lei sintética nº 10\nTexto não disponível na origem."),
		Buffer.from("---\ntitulo: incompleto"),
		fixture({ extra: Number.POSITIVE_INFINITY }),
		Buffer.alloc(LIMITS.fileBytes + 1),
	];
	for (const bytes of bad) assert.throws(() => parseLaw(bytes, PATH));
});
test("13 coleções explícitas; exclusões e caminhos perigosos", () => {
	assert.equal(Object.keys(COLLECTIONS).length, 13);
	assert.equal(scope(PATH), null);
	for (const p of [
		"constituicao.md",
		"estadual/lei.md",
		"federal/regimentos/a.md",
		"federal/regulamentos/2002/a.md",
		"federal/constituicoes-historicas/2002/a.md",
		"federal/leis-ordinarias/2002/_falhas.md",
		"federal/leis-ordinarias/2002/anexos/a.md",
	])
		assert.ok(scope(p));
	for (const p of [
		"/a",
		"federal/../lei.md",
		"federal/./lei.md",
		"federal//lei.md",
		"a\\b",
	])
		assert.throws(() => scope(p));
});
test("dry-run sem banco: reconcilia exclusões, sucesso e falhas, sem buscar URLs YAML", async () => {
	const s = snapshot({
		[PATH]: fixture(),
		"constituicao.md": Buffer.from("não ler"),
		"federal/leis-ordinarias/2002/bad.md": Buffer.from("bad"),
	});
	const report = await ingest(s);
	assert.equal(report.dryRun, true);
	assert.equal(report.checkpointAdvanced, false);
	assert.equal(report.inventoried, 3);
	assert.equal(report.inserted, 1);
	assert.equal(report.failed, 1);
	assert.equal(report.excluded, 1);
	assert.equal(s.reads.length, 2);
});
test("conexão aceita somente endpoint Supabase local, sem parâmetros de redirecionamento", () => {
	assert.equal(
		localDatabaseUrl("postgresql://runner:local@127.0.0.1:54322/postgres"),
		"postgresql://runner:local@127.0.0.1:54322/postgres",
	);
	for (const u of [
		undefined,
		"postgresql://runner@localhost:54322/postgres",
		"postgresql://runner@db.remote:54322/postgres",
		"postgresql://runner@127.0.0.1:5432/postgres",
		"postgresql://service_role@127.0.0.1:54322/postgres",
		"postgresql://runner@127.0.0.1:54322/postgres?host=remote",
	])
		assert.throws(() => localDatabaseUrl(u));
});
