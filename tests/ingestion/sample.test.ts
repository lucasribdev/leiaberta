import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { LIMITS } from "../../scripts/ingestion/model.ts";
import { acquireSample } from "../../scripts/ingestion/sample.ts";
import { fixture, PATH } from "./fixtures.ts";

const commit = "a".repeat(40);
const bytes = fixture();
const blob = createHash("sha1")
	.update(`blob ${bytes.length}\0`)
	.update(bytes)
	.digest("hex");

test("aquisição limitada fixa referência uma vez, valida árvores, modo, tamanho e blob; somente origens fixas", async (t) => {
	const calls: string[] = [];
	let mode = "100644";
	let content = bytes;
	let truncated = false;
	t.mock.method(
		globalThis,
		"fetch",
		async (url: string, options: RequestInit) => {
			calls.push(url);
			assert.equal(options.redirect, "error");
			assert.ok(options.signal);
			if (url.endsWith("/git/ref/heads/main"))
				return Response.json({ object: { sha: commit, type: "commit" } });
			const tree = [
				{ path: "federal", mode: "040000", type: "tree", sha: "b".repeat(40) },
				{
					path: "leis-ordinarias",
					mode: "040000",
					type: "tree",
					sha: "c".repeat(40),
				},
				{ path: "2002", mode: "040000", type: "tree", sha: "d".repeat(40) },
				{
					path: PATH.split("/")[3],
					mode,
					type: "blob",
					sha: blob,
					size: bytes.length,
				},
			];
			const shas = [commit, "b".repeat(40), "c".repeat(40), "d".repeat(40)];
			const index = shas.findIndex(
				(sha) =>
					url === `https://api.github.com/repos/ctresb/leis/git/trees/${sha}`,
			);
			if (index >= 0) return Response.json({ truncated, tree: [tree[index]] });
			assert.equal(
				url,
				`https://raw.githubusercontent.com/ctresb/leis/${commit}/${PATH}`,
			);
			return new Response(Uint8Array.from(content));
		},
	);
	const source = await acquireSample("main", [PATH]);
	assert.equal(source.commit, commit);
	assert.equal(source.inventoryComplete, false);
	const [entry] = await source.inventory(commit);
	assert.deepEqual(await source.read(entry), bytes);
	assert.equal(calls.filter((c) => c.includes("/ref/")).length, 1);
	assert.equal(calls.length, 6);
	await assert.rejects(source.inventory("e".repeat(40)), {
		code: "invalid_commit",
	});
	await assert.rejects(source.read({ ...entry, path: "other.md" }), {
		code: "unsafe_blob",
	});
	content = Buffer.alloc(bytes.length);
	await assert.rejects(source.read(entry), { code: "blob_integrity" });
	content = Buffer.alloc(LIMITS.fileBytes + 1);
	await assert.rejects(source.read(entry), { code: "sample_limit" });
	for (mode of ["100755", "120000", "160000"])
		await assert.rejects(acquireSample(commit, [PATH]), {
			code: "unsafe_blob",
		});
	mode = "100644";
	truncated = true;
	await assert.rejects(acquireSample(commit, [PATH]));
	assert.equal(calls.filter((c) => c.includes("/ref/")).length, 1);
});

test("validação de seleção não consulta rede para caminhos inválidos, duplicados, fora do recorte ou mais de 20", async (t) => {
	t.mock.method(globalThis, "fetch", () => assert.fail("Sem rede"));
	for (const paths of [
		[],
		[PATH, PATH],
		Array.from({ length: 21 }, (_, i) => PATH.replace("lei-10", `lei-${i}`)),
		["../x"],
		["constituicao.md"],
		["federal/regimentos/a.md"],
	])
		await assert.rejects(acquireSample(commit, paths));
	await assert.rejects(acquireSample("../main", [PATH]));
});
