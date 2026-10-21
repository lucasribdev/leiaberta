import { createHash } from "node:crypto";
import { z } from "zod";
import {
	type Entry,
	IngestionError,
	LIMITS,
	type Snapshot,
	scope,
} from "./model.ts";

const API = "https://api.github.com/repos/ctresb/leis";
const oid = z.string().regex(/^[a-f0-9]{40}$/);
const treeSchema = z.object({
	truncated: z.literal(false),
	tree: z.array(
		z.object({
			path: z.string(),
			mode: z.string(),
			type: z.string(),
			sha: oid,
			size: z.number().int().nonnegative().optional(),
		}),
	),
});

// Fixed GitHub origins only; redirects and response bodies are bounded. Never use YAML URLs.
async function download(url: string, limit: number): Promise<Buffer> {
	const response = await fetch(url, {
		redirect: "error",
		signal: AbortSignal.timeout(LIMITS.timeoutMs),
		headers: {
			"User-Agent": "LeiAberta-LA005",
			Accept: "application/vnd.github+json",
		},
	});
	if (!response.ok || !response.body)
		throw new IngestionError(
			"sample_acquisition",
			"Aquisição limitada falhou no GitHub",
		);
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of response.body) {
		size += chunk.length;
		if (size > limit)
			throw new IngestionError(
				"sample_limit",
				"Resposta da amostra excede limite",
			);
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

export async function acquireSample(
	reference: string,
	paths: string[],
): Promise<Snapshot> {
	if (
		paths.length < 1 ||
		paths.length > 20 ||
		new Set(paths).size !== paths.length ||
		paths.some((p) => scope(p) !== null)
	)
		throw new IngestionError(
			"sample_paths",
			"Amostra exige 1 a 20 caminhos únicos no recorte",
		);
	if (
		!/^[a-zA-Z0-9][a-zA-Z0-9/._-]{0,199}$/.test(reference) ||
		reference.includes("..")
	)
		throw new IngestionError("invalid_ref", "Referência inválida");
	// Resolve a branch exactly once; a supplied immutable commit needs no ref lookup.
	const commit = oid.safeParse(reference).success
		? reference
		: z
				.object({
					object: z.object({ sha: oid, type: z.literal("commit") }),
				})
				.parse(
					JSON.parse(
						(
							await download(`${API}/git/ref/heads/${reference}`, 16384)
						).toString(),
					),
				).object.sha;
	const trees = new Map<string, z.infer<typeof treeSchema>>();
	async function tree(sha: string) {
		let value = trees.get(sha);
		if (!value) {
			value = treeSchema.parse(
				JSON.parse(
					(
						await download(`${API}/git/trees/${sha}`, LIMITS.fileBytes)
					).toString(),
				),
			);
			trees.set(sha, value);
		}
		return value;
	}
	const entries: Entry[] = [];
	for (const path of paths) {
		const parts = path.split("/");
		let sha = commit;
		for (const [i, part] of parts.entries()) {
			const node = (await tree(sha)).tree.find((n) => n.path === part);
			if (!node)
				throw new IngestionError(
					"sample_path_missing",
					"Caminho da amostra ausente no commit",
				);
			if (i < parts.length - 1) {
				if (node.type !== "tree" || node.mode !== "040000")
					throw new IngestionError(
						"unsafe_blob",
						"Diretório da amostra inválido",
					);
				sha = node.sha;
			} else {
				if (
					node.type !== "blob" ||
					node.mode !== "100644" ||
					node.size === undefined ||
					node.size > LIMITS.fileBytes
				)
					throw new IngestionError(
						"unsafe_blob",
						"Tipo ou tamanho de blob não permitido",
					);
				entries.push({
					path,
					blob: node.sha,
					mode: node.mode,
					size: node.size,
				});
			}
		}
	}
	return {
		commit,
		inventoryComplete: false,
		async inventory(requested) {
			if (requested !== commit)
				throw new IngestionError("invalid_commit", "Commit diverge da amostra");
			return entries.map((e) => ({ ...e }));
		},
		async read(entry) {
			if (
				!entries.some(
					(e) =>
						e.path === entry.path &&
						e.blob === entry.blob &&
						e.size === entry.size &&
						e.mode === entry.mode,
				)
			)
				throw new IngestionError("unsafe_blob", "Blob fora da amostra");
			const bytes = await download(
				`https://raw.githubusercontent.com/ctresb/leis/${commit}/${entry.path}`,
				LIMITS.fileBytes,
			);
			const hash = createHash("sha1")
				.update(`blob ${bytes.length}\0`)
				.update(bytes)
				.digest("hex");
			if (bytes.length !== entry.size || hash !== entry.blob)
				throw new IngestionError(
					"blob_integrity",
					"Tamanho ou hash Git divergente",
				);
			return bytes;
		},
	};
}
