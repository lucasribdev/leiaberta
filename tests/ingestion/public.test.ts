import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseDocument } from "yaml";
import type { Database } from "../../scripts/ingestion/database.ts";
import {
	COLLECTIONS,
	type Entry,
	sha256,
} from "../../scripts/ingestion/model.ts";
import { parseLaw } from "../../scripts/ingestion/parser.ts";
import { ingest } from "../../scripts/ingestion/runner.ts";

const root = new URL("./public/", import.meta.url);
const manifest: {
	file: string;
	path: string;
	commit: string;
	blob: string;
	size: number;
	sha256: string;
}[] = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
const files = new Map(
	await Promise.all(
		manifest.map(
			async (m) => [m.path, await readFile(new URL(m.file, root))] as const,
		),
	),
);
const entries = manifest.map((m) => ({
	path: m.path,
	blob: m.blob,
	size: m.size,
	mode: "100644",
}));
const source = {
	commit: manifest[0].commit,
	inventoryComplete: false,
	async inventory() {
		return entries;
	},
	async read(entry: Entry) {
		const bytes = files.get(entry.path);
		assert.ok(bytes);
		return bytes;
	},
};

test("15 documentos reais: proveniência, bytes originais, projeção e metadados preservados nas 13 coleções", () => {
	assert.equal(manifest.length, 15);
	assert.deepEqual(
		new Set(manifest.map((m) => m.path.split("/")[1])),
		new Set(Object.keys(COLLECTIONS)),
	);
	for (const m of manifest) {
		const bytes = files.get(m.path);
		assert.ok(bytes);
		assert.equal(m.commit, "15eb09b618ff08a38c4dfee06a91bd139d093f5d");
		assert.equal(bytes.length, m.size);
		assert.equal(sha256(bytes), m.sha256);
		assert.equal(
			createHash("sha1")
				.update(`blob ${bytes.length}\0`)
				.update(bytes)
				.digest("hex"),
			m.blob,
		);
		const [, yaml, body] = bytes.toString().split("---\n");
		const metadata = parseDocument(yaml, { schema: "core" }).toJS();
		const { projection: p, hash, warnings } = parseLaw(bytes, m.path);
		assert.equal(hash, m.sha256);
		assert.deepEqual(p.source_metadata, metadata);
		assert.equal(p.legislative_text, body.trim());
		assert.equal(p.number, metadata.numero || null);
		assert.equal(p.source_urn, metadata.urn ?? null);
		assert.equal(p.official_source_url, metadata.fonte);
		assert.equal(p.enactment_date, metadata.data);
		assert.equal(p.publication_date, null);
		assert.equal(p.source_downloaded_at, metadata.baixado_em);
		assert.equal(p.year, Number(m.path.split("/")[2]));
		assert.equal(Object.hasOwn(p, "legal_status"), false);
		assert.deepEqual(warnings, []);
	}
	const projections = manifest.map(
		(m) => parseLaw(files.get(m.path) as Buffer, m.path).projection,
	);
	assert.equal(projections.filter((p) => p.number === null).length, 3);
	assert.equal(projections[2].number, "14-A");
	assert.equal(projections[3].number, "1463-2");
	assert.equal(projections[4].source_urn, null);
	assert.match(String(projections[7].legislative_text), /<table>/);
	assert.equal(
		(projections[5].source_metadata as Record<string, unknown>)
			.forca_legal_fonte,
		'["NotInForce"]',
	);
});

test("dry-run real repetível: contadores, hashes e diagnósticos; amostra nunca é inventário completo", async () => {
	const first = await ingest(source);
	assert.deepEqual(await ingest(source), first);
	assert.deepEqual(
		JSON.parse(JSON.stringify(first)),
		JSON.parse(
			await readFile(
				new URL("../../docs/ingestion-sample-report.json", import.meta.url),
				"utf8",
			),
		),
	);
	assert.equal(first.dryRun, true);
	assert.equal(first.inventoryComplete, false);
	assert.equal(first.checkpointAdvanced, false);
	assert.equal(first.inserted, 15);
	assert.equal(first.inventoried, 15);
	assert.equal(
		first.failed +
			first.conflict +
			first.removed +
			first.updated +
			first.unchanged +
			first.excluded,
		0,
	);
	for (const [i, item] of first.items.entries())
		assert.equal(item.source_hash, manifest[i].sha256);
});

test("amostragem rejeita banco, retomada e arquivo de artefatos antes de qualquer efeito", async () => {
	const db = new Proxy(
		{},
		{
			get() {
				assert.fail("Não deve acessar banco");
			},
		},
	) as Database;
	for (const options of [
		{ db },
		{ resume: "x" },
		{ archive: async () => assert.fail("Não deve arquivar") },
	])
		await assert.rejects(ingest(source, options), {
			code: "sample_dry_run_only",
		});
});

test("campo novo preservado/avisado e divergência de identidade diagnosticada em derivação de fixture real", async () => {
	const m = manifest[2];
	const bytes = files.get(m.path);
	assert.ok(bytes);
	const changed = Buffer.from(
		bytes
			.toString()
			.replace("---\n", "---\nnovo_campo: {nested: [1, null, true]}\n"),
	);
	const parsed = parseLaw(changed, m.path);
	assert.deepEqual(parsed.warnings, ["unknown_metadata:novo_campo"]);
	assert.deepEqual(
		(parsed.projection.source_metadata as Record<string, unknown>).novo_campo,
		{ nested: [1, null, true] },
	);
	const bad = Buffer.from(
		bytes.toString().replace('numero: "14-A"', 'numero: "15-A"'),
	);
	const report = await ingest({
		...source,
		async inventory() {
			return [entries[2]];
		},
		async read() {
			return bad;
		},
	});
	assert.equal(report.failed, 1);
	assert.equal(report.items[0].error_code, "identity_title");
	assert.equal(report.items[0].source_hash, sha256(bad));
	assert.equal(report.checkpointAdvanced, false);
});
