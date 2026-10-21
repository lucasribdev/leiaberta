import { createHash } from "node:crypto";

export const REPOSITORY = "https://github.com/ctresb/leis";
export const PARSER_VERSION = "la005-v1";
export const COLLECTIONS: Record<string, readonly string[]> = {
	"leis-ordinarias": ["Lei Ordinária", "Lei (não numerada)"],
	"leis-complementares": ["Lei Complementar"],
	"leis-delegadas": ["Lei Delegada"],
	"leis-constitucionais": ["Lei Constitucional"],
	"decretos-lei": ["Decreto-Lei"],
	"emendas-constitucionais": [
		"Emenda Constitucional",
		"Emenda Constitucional de Revisão",
	],
	decretos: ["Decreto"],
	"decretos-nao-numerados": ["Decreto (não numerado)"],
	"decretos-legislativos": [
		"Decreto Legislativo",
		"Decreto do Poder Legislativo",
	],
	"medidas-provisorias": ["Medida Provisória"],
	"resolucoes-camara": ["Resolução da Câmara dos Deputados"],
	"resolucoes-senado": ["Resolução do Senado Federal"],
	"resolucoes-congresso": [
		"Resolução do Congresso Nacional",
		"Resolução da Revisão Constitucional",
	],
};
export const LIMITS = {
	fileBytes: 2 * 1024 * 1024,
	depth: 20,
	files: 300_000,
	gitOutput: 96 * 1024 * 1024,
	timeoutMs: 30_000,
	parseTimeoutMs: 5_000,
	retries: 0,
	concurrency: 1,
};
export const OFFICIAL_HOSTS = [
	"normas.leg.br",
	"www.planalto.gov.br",
	"www2.camara.leg.br",
	"www.camara.leg.br",
	"www25.senado.leg.br",
	"legis.senado.leg.br",
	"www.senado.leg.br",
];
export const CONFIG_HASH = digest({ COLLECTIONS, LIMITS, OFFICIAL_HOSTS });
export function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
export function digest(value: unknown): string {
	return sha256(canonical(value));
}
export class IngestionError extends Error {
	code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}
export interface Entry {
	path: string;
	blob: string;
	mode: string;
	size: number;
}
export interface Snapshot {
	commit: string;
	inventory(commit: string): Promise<Entry[]>;
	read(entry: Entry): Promise<Buffer>;
}
export function scope(path: string): string | null {
	if (
		path.startsWith("/") ||
		path.split("/").some((p) => p === ".." || p === "." || !p) ||
		path.includes("\\") ||
		Array.from(path).some(
			(c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
		)
	)
		throw new IngestionError("unsafe_path", "Caminho Git inválido");
	const parts = path.split("/");
	if (parts[0] !== "federal") return "outside_federal";
	if (!Object.hasOwn(COLLECTIONS, parts[1] ?? ""))
		return "collection_not_allowed";
	if (
		parts.length !== 4 ||
		!/^\d{4}$/.test(parts[2]) ||
		!/^[a-z0-9][a-z0-9-]*\.md$/.test(parts[3])
	)
		return "auxiliary_or_layout";
	return null;
}
export const PROJECTION_KEYS = [
	"law_type",
	"number",
	"year",
	"title",
	"summary",
	"legislative_text",
	"publication_date",
	"enactment_date",
	"publication_reference",
	"text_version",
	"official_source_url",
	"source_urn",
	"source_metadata",
	"source_downloaded_at",
] as const;
export type Projection = Record<(typeof PROJECTION_KEYS)[number], unknown>;
export function projectionHash(row: Record<string, unknown>): string {
	return digest(Object.fromEntries(PROJECTION_KEYS.map((k) => [k, row[k]])));
}
export type Outcome =
	| "inserted"
	| "updated"
	| "unchanged"
	| "excluded"
	| "removed"
	| "failed"
	| "conflict";
