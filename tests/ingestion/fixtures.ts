import { createHash } from "node:crypto";
import { stringify } from "yaml";
import type { Entry, Snapshot } from "../../scripts/ingestion/model.ts";

export const PATH = "federal/leis-ordinarias/2002/lei-10-2002-01-10.md";
export const RENAMED = "federal/leis-ordinarias/2002/lei-10-renomeada.md";
export const URN = "urn:lex:br:federal:lei:2002-01-10;10";
export function fixture(
	changes: Record<string, unknown> = {},
	body?: string,
): Buffer {
	const metadata = {
		titulo: "Lei sintética nº 10",
		tipo: "Lei Ordinária",
		numero: "10",
		data: "2002-01-10",
		ementa: "Exemplo sintético determinístico",
		fonte: "https://normas.leg.br/?urn=exemplo",
		baixado_em: "2026-01-01",
		revogada: false,
		...changes,
	};
	return Buffer.from(
		`---\n${stringify(metadata)}---\n${body ?? `# ${metadata.titulo}\n\nArt. 1º Esta norma é uma fixture sintética para testes locais.\n`}`,
	);
}
export function snapshot(
	files: Record<string, Buffer>,
	version = "a",
): Snapshot & { reads: string[] } {
	const reads: string[] = [];
	const blobs = new Map<string, Buffer>();
	const entries: Entry[] = Object.entries(files).map(([path, bytes]) => {
		const blob = createHash("sha1")
			.update(`blob ${bytes.length}\0`)
			.update(bytes)
			.digest("hex");
		blobs.set(blob, bytes);
		return { path, blob, size: bytes.length, mode: "100644" };
	});
	return {
		commit: version.repeat(40),
		reads,
		async inventory() {
			return entries;
		},
		async read(entry) {
			reads.push(entry.path);
			const bytes = blobs.get(entry.blob);
			if (!bytes) throw new Error("missing");
			return bytes;
		},
	};
}
