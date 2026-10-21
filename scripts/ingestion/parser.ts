import { parseDocument, visit } from "yaml";
import { z } from "zod";
import {
	COLLECTIONS,
	IngestionError,
	LIMITS,
	OFFICIAL_HOSTS,
	type Projection,
	scope,
	sha256,
} from "./model.ts";

const nonempty = z.string().trim().min(1);
const date = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine(
		(v) =>
			Number.isFinite(Date.parse(v)) &&
			new Date(v).toISOString().slice(0, 10) === v,
		"Data inválida",
	);
const optionalText = z.string().nullable().optional();
const schema = z
	.object({
		titulo: nonempty,
		tipo: nonempty,
		numero: optionalText,
		data: date.nullable().optional(),
		ano: z.union([z.number().int(), z.string().regex(/^\d{4}$/)]).optional(),
		ementa: optionalText,
		fonte: z.string().url(),
		urn: optionalText,
		data_publicacao: date.nullable().optional(),
		baixado_em: date.nullable().optional(),
		publicacao: optionalText,
		versao_texto: optionalText,
		revogada: z.boolean().nullable().optional(),
		identidade_pendente_revisao: z.boolean().optional(),
		uf: optionalText,
	})
	.passthrough();
const known = new Set([
	...Object.keys(schema.shape),
	"situacao",
	"forca_legal_fonte",
	"arquivo",
	"fonte_indice",
	"id_senado",
	"url_metadados",
	"fonte_metadados",
	"sha256_metadados_fonte",
	"recuperacao_integralidade",
	"sha256_md_historico",
	"sha256_pdf_fonte",
	"atualizado_ate",
]);
const lexTypes: Record<string, string> = {
	"Lei Ordinária": "lei",
	"Lei (não numerada)": "lei",
	"Lei Complementar": "lei.complementar",
	"Lei Delegada": "lei.delegada",
	"Lei Constitucional": "lei.constitucional",
	"Decreto-Lei": "decreto.lei",
	"Emenda Constitucional": "emenda.constitucional",
	"Emenda Constitucional de Revisão": "emenda.constitucional.revisao",
	Decreto: "decreto",
	"Decreto (não numerado)": "decreto",
	"Decreto Legislativo": "decreto.legislativo",
	"Decreto do Poder Legislativo": "decreto.legislativo",
	"Medida Provisória": "medida.provisoria",
	"Resolução da Câmara dos Deputados": "resolucao",
	"Resolução do Senado Federal": "resolucao",
	"Resolução do Congresso Nacional": "resolucao",
	"Resolução da Revisão Constitucional": "resolucao.revisao.constitucional",
};
function fail(code: string, message: string): never {
	throw new IngestionError(code, message);
}
function jsonSafe(value: unknown, depth = 0): void {
	if (depth > LIMITS.depth) fail("yaml_depth", "Profundidade YAML excedida");
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return;
	if (typeof value === "number" && Number.isFinite(value)) return;
	if (Array.isArray(value)) {
		for (const child of value) jsonSafe(child, depth + 1);
		return;
	}
	if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) {
			if (["__proto__", "constructor", "prototype"].includes(key))
				fail("unsafe_key", "Chave reservada");
			jsonSafe(child, depth + 1);
		}
		return;
	}
	fail("invalid_metadata", "Metadados não representáveis em JSON");
}
export function parseLaw(
	bytes: Buffer,
	path: string,
): { projection: Projection; hash: string; warnings: string[] } {
	if (scope(path)) fail("outside_scope", "Documento fora do recorte");
	if (bytes.length > LIMITS.fileBytes)
		fail("file_size", "Arquivo excede limite");
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return fail("invalid_utf8", "UTF-8 inválido");
	}
	if (
		Array.from(text).some((c) => {
			const code = c.charCodeAt(0);
			return (
				(code < 32 && ![9, 10, 13].includes(code)) ||
				code === 127 ||
				code === 65533
			);
		}) ||
		/Ã[\u0080-\u00bf]|â€|Â[\s§]/u.test(text)
	)
		fail("encoding_review", "Codificação exige revisão");
	const normalized = text.replace(/\r\n/g, "\n");
	const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(normalized);
	if (!match) fail("front_matter", "Front matter ausente ou incompleto");
	const document = parseDocument(match[1], {
		schema: "core",
		uniqueKeys: true,
		strict: true,
		customTags: [],
	});
	if (document.errors.length || document.warnings.length)
		fail("invalid_yaml", "YAML inválido, duplicado ou tag não permitida");
	visit(document, {
		Alias() {
			fail("yaml_alias", "Aliases YAML não permitidos");
		},
		Node(_key, _node, ancestors) {
			if (ancestors.length > LIMITS.depth)
				fail("yaml_depth", "Profundidade YAML excedida");
		},
	});
	const raw: unknown = document.toJS({ maxAliasCount: 0 });
	jsonSafe(raw);
	const parsed = schema.safeParse(raw);
	if (!parsed.success)
		fail(
			"invalid_document",
			`Campos inválidos: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
		);
	const m = parsed.data;
	const [, collection, folderYear] = path.split("/");
	if (!COLLECTIONS[collection].includes(m.tipo))
		fail("identity_type", "Tipo diverge da coleção");
	if (m.uf && !["BR", "br", "federal"].includes(m.uf))
		fail("identity_jurisdiction", "Jurisdição divergente");
	if (m.identidade_pendente_revisao)
		fail("identity_pending", "Identidade pendente de revisão na fonte");
	const year = m.data ? Number(m.data.slice(0, 4)) : Number(m.ano);
	if (
		!Number.isInteger(year) ||
		year < 1800 ||
		year > new Date().getUTCFullYear() ||
		year !== Number(folderYear) ||
		(m.ano !== undefined && Number(m.ano) !== year)
	)
		fail("identity_year", "Ano ausente, futuro ou divergente");
	for (const d of [m.data, m.data_publicacao, m.baixado_em])
		if (d && d > new Date().toISOString().slice(0, 10))
			fail("future_date", "Data futura exige revisão");
	const url = new URL(m.fonte);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		(url.port && url.port !== "443") ||
		!OFFICIAL_HOSTS.includes(url.hostname)
	)
		fail("official_url", "URL oficial fora da allowlist");
	const number = m.numero?.trim() || null;
	if (number && !/^\d+(?:-[A-Za-z0-9]+)*$/.test(number))
		fail("identity_number", "Número não reconhecido");
	const epigraphNumber = /\bn[º°o.]?\s*(\d[\d.]*(?:-[a-z0-9]+)*)/i.exec(
		m.titulo,
	)?.[1];
	if (
		epigraphNumber &&
		epigraphNumber.replaceAll(".", "").toLowerCase() !== number?.toLowerCase()
	)
		fail("identity_title", "Número da epígrafe diverge dos metadados");
	const epigraphDate = /\b(\d{2})\/(\d{2})\/(\d{4})\b/.exec(m.titulo);
	if (
		epigraphDate &&
		m.data !== `${epigraphDate[3]}-${epigraphDate[2]}-${epigraphDate[1]}`
	)
		fail("identity_title", "Data da epígrafe diverge dos metadados");
	const urn = m.urn?.trim().toLowerCase() || null;
	const urlUrn = url.searchParams.get("urn");
	if (urn && urlUrn?.startsWith("urn:lex:") && urn !== urlUrn.toLowerCase())
		fail("identity_url", "URN da URL oficial diverge");
	if (urn) {
		const u =
			/^urn:lex:br:([a-z.]+):([a-z.]+):(\d{4}(?:-\d{2}-\d{2})?);([a-z0-9-]+)$/.exec(
				urn,
			);
		const authority =
			collection === "resolucoes-camara"
				? "camara.deputados"
				: collection === "resolucoes-senado"
					? "senado.federal"
					: collection === "resolucoes-congresso"
						? "congresso.nacional"
						: "federal";
		if (
			!u ||
			u[1] !== authority ||
			u[2] !== lexTypes[m.tipo] ||
			u[3] !== (m.data ?? String(year)) ||
			(number ? u[4] !== number.toLowerCase() : !/^seq-sf-\d+$/.test(u[4]))
		)
			fail("identity_urn", "URN diverge da identidade declarada");
	}
	const body = match[2].trim();
	const heading = /^#\s+(.+)$/m.exec(body);
	if (
		!heading ||
		heading[1].trim() !== m.titulo ||
		body.replace(/^#\s+.*$/gm, "").trim().length < 20 ||
		/(?:texto|conte[uú]do) (?:n[aã]o (?:dispon[ií]vel|encontrado)|indispon[ií]vel)|sem texto|em constru[cç][aã]o/i.test(
			body,
		)
	)
		fail("incomplete_document", "Título divergente ou texto incompleto");
	const nullable = (v: string | null | undefined) => v?.trim() || null;
	return {
		hash: sha256(bytes),
		warnings: Object.keys(m)
			.filter((k) => !known.has(k))
			.map((k) => `unknown_metadata:${k}`),
		projection: {
			law_type: m.tipo,
			number,
			year,
			title: m.titulo,
			summary: nullable(m.ementa),
			legislative_text: body,
			publication_date: m.data_publicacao ?? null,
			enactment_date: m.data ?? null,
			publication_reference: nullable(m.publicacao),
			text_version: nullable(m.versao_texto),
			official_source_url: m.fonte,
			source_urn: urn,
			source_metadata: raw,
			source_downloaded_at: m.baixado_em ?? null,
		},
	};
}
