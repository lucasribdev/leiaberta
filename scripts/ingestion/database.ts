import pg from "pg";
import {
	IngestionError,
	LIMITS,
	type Outcome,
	PROJECTION_KEYS,
	type Projection,
	REPOSITORY,
} from "./model.ts";

export interface Law extends Record<string, unknown> {
	id: string;
	source_id: string;
	source_path: string;
	source_urn: string | null;
	source_hash: string;
	source_blob_sha: string;
	source_removed_at: string | null;
}
export interface Item {
	source_path: string;
	previous_path?: string;
	operation: string;
	blob_sha?: string;
	source_hash?: string;
	law_id?: string;
	outcome: Outcome;
	attempt?: number;
	error_code?: string;
	error_message?: string;
	artifact_reference?: string;
	source_metadata?: Record<string, unknown>;
}
export interface Run {
	id: string;
	target_commit_sha: string;
	base_commit_sha: string | null;
	parser_version: string;
	config_hash: string;
	status: string;
	counters?: { removals?: { path: string; id: string }[] };
}
// Dates must stay date-only strings, independent of the host timezone.
export const databaseTypes = {
	getTypeParser: (oid: number, format?: string) =>
		oid === 1082
			? (value: string) => value
			: pg.types.getTypeParser(oid, format as "text"),
};
export function localDatabaseUrl(value: string | undefined): string {
	if (!value)
		throw new IngestionError(
			"database_config",
			"Defina INGESTION_DATABASE_URL somente no servidor",
		);
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new IngestionError("database_config", "URL PostgreSQL inválida");
	}
	if (
		!["postgres:", "postgresql:"].includes(url.protocol) ||
		!["127.0.0.1", "[::1]"].includes(url.hostname) ||
		url.port !== "54322" ||
		url.pathname !== "/postgres" ||
		url.search ||
		!url.username ||
		["service_role", "authenticator", "anon", "authenticated"].includes(
			decodeURIComponent(url.username),
		)
	)
		throw new IngestionError(
			"local_only",
			"Aceita apenas PostgreSQL Supabase local em loopback:54322/postgres, sem parâmetros",
		);
	return value;
}
export class Database {
	client: pg.Client;
	constructor(client: pg.Client) {
		this.client = client;
	}
	static async connect(value: string | undefined): Promise<Database> {
		const client = new pg.Client({
			connectionString: localDatabaseUrl(value),
			types: databaseTypes,
			connectionTimeoutMillis: 5000,
			query_timeout: LIMITS.timeoutMs,
			statement_timeout: 10000,
			application_name: "leiaberta-ingestion",
		});
		await client.connect();
		try {
			// No membership or credentials are created. The connection must already be authorized.
			await client.query("set role law_ingestor");
			const { rows } = await client.query(
				"select current_user as role, inet_server_addr()::text as address, current_database() as database",
			);
			if (
				rows[0].role !== "law_ingestor" ||
				rows[0].database !== "postgres" ||
				!rows[0].address
			)
				throw new IngestionError(
					"database_role",
					"Conexão de ingestão inválida",
				);
			return new Database(client);
		} catch (error) {
			await client.end();
			throw error;
		}
	}
	async transaction<T>(fn: () => Promise<T>): Promise<T> {
		await this.client.query("begin");
		try {
			const result = await fn();
			await this.client.query("commit");
			return result;
		} catch (error) {
			await this.client.query("rollback");
			throw error;
		}
	}
	async lock(): Promise<void> {
		const { rows } = await this.client.query(
			"select pg_try_advisory_lock(hashtext($1)) as acquired",
			[REPOSITORY],
		);
		if (!rows[0].acquired)
			throw new IngestionError("concurrent_run", "Outro importador está ativo");
	}
	async unlock(): Promise<void> {
		await this.client.query("select pg_advisory_unlock(hashtext($1))", [
			REPOSITORY,
		]);
	}
	async checkpoint(): Promise<
		| { commit_sha: string; parser_version: string; config_hash: string }
		| undefined
	> {
		return (
			await this.client.query(
				"select c.commit_sha, r.parser_version, r.config_hash from ingestion_private.checkpoints c join ingestion_private.runs r on r.id=c.run_id where c.repository=$1",
				[REPOSITORY],
			)
		).rows[0];
	}
	async laws(): Promise<Law[]> {
		return (await this.client.query<Law>("select * from public.laws")).rows;
	}
	async paths(): Promise<
		{ source_path: string; law_id: string; closed_at: string | null }[]
	> {
		return (
			await this.client.query(
				"select source_path, law_id, closed_at from ingestion_private.law_source_paths",
			)
		).rows;
	}
	async latest(lawId: string): Promise<Record<string, unknown> | undefined> {
		return (
			await this.client.query(
				"select source_metadata || jsonb_build_object('sourceHash',source_hash,'blobSha',blob_sha) as source_metadata from ingestion_private.items where law_id=$1 and outcome in ('inserted','updated','unchanged') order by event_sequence desc limit 1",
				[lawId],
			)
		).rows[0]?.source_metadata;
	}
	async pending(): Promise<Item[]> {
		return (
			await this.client.query<Item>(
				"select * from (select distinct on (source_path) * from ingestion_private.items order by source_path, event_sequence desc) latest where outcome in ('failed','conflict')",
			)
		).rows;
	}
	async items(runId: string): Promise<Item[]> {
		return (
			await this.client.query<Item>(
				"select distinct on (source_path) * from ingestion_private.items where run_id=$1 order by source_path, attempt desc",
				[runId],
			)
		).rows;
	}
	async start(
		commit: string,
		base: string | null,
		parser: string,
		config: string,
		mode: string,
		resume?: string,
	): Promise<Run> {
		if (resume) {
			const run: Run | undefined = (
				await this.client.query(
					"select * from ingestion_private.runs where id=$1",
					[resume],
				)
			).rows[0];
			if (
				!run ||
				run.target_commit_sha !== commit ||
				run.base_commit_sha !== base ||
				run.parser_version !== parser ||
				run.config_hash !== config ||
				!["running", "failed", "cancelled"].includes(run.status)
			)
				throw new IngestionError(
					"resume_mismatch",
					"Retomada exige mesmo commit, base, parser e configuração",
				);
			await this.client.query(
				"update ingestion_private.runs set status='running', finished_at=null where id=$1",
				[resume],
			);
			return run;
		}
		return (
			await this.client.query(
				"insert into ingestion_private.runs(target_commit_sha,base_commit_sha,parser_version,config_hash,mode,started_at) values($1,$2,$3,$4,$5,statement_timestamp()) returning *",
				[commit, base, parser, config, mode],
			)
		).rows[0];
	}
	async record(run: string, item: Item): Promise<void> {
		await this.client.query(
			`insert into ingestion_private.items(run_id,source_path,previous_path,operation,blob_sha,source_hash,law_id,outcome,attempt,error_code,error_message,artifact_reference,source_metadata,recorded_at)
   values($1,$2,$3,$4,$5,$6,$7,$8,(select coalesce(max(attempt),0)+1 from ingestion_private.items where run_id=$1 and source_path=$2),$9,$10,$11,$12,statement_timestamp())`,
			[
				run,
				item.source_path,
				item.previous_path ?? null,
				item.operation,
				item.blob_sha ?? null,
				item.source_hash ?? null,
				item.law_id ?? null,
				item.outcome,
				item.error_code ?? null,
				item.error_message ?? null,
				item.artifact_reference ?? null,
				JSON.stringify(item.source_metadata ?? {}),
			],
		);
	}
	async save(
		projection: Projection,
		provenance: Record<string, unknown>,
		law?: Law,
	): Promise<Law> {
		const values: Record<string, unknown> = { ...projection, ...provenance };
		// Keys come exclusively from the internal projection/provenance, never YAML keys.
		const allowed = [
			...PROJECTION_KEYS,
			"source_commit_sha",
			"source_blob_sha",
			"source_removed_at",
			"source_path",
			"source_url",
			"source_hash",
			"imported_at",
			...(!law ? ["source_id"] : []),
		];
		if (Object.keys(values).some((k) => !allowed.includes(k)))
			throw new IngestionError("projection_keys", "Coluna não permitida");
		const keys = Object.keys(values);
		const args = keys.map((k) =>
			k === "source_metadata" ? JSON.stringify(values[k]) : values[k],
		);
		if (law)
			return (
				await this.client.query<Law>(
					`update public.laws set ${keys.map((k, i) => `${k}=$${i + 1}`).join(",")} where id=$${keys.length + 1} returning *`,
					[...args, law.id],
				)
			).rows[0];
		return (
			await this.client.query<Law>(
				`insert into public.laws(${keys.join(",")}) values(${keys.map((_, i) => `$${i + 1}`).join(",")}) returning *`,
				args,
			)
		).rows[0];
	}
	async closePath(law: Law, commit: string): Promise<void> {
		await this.client.query(
			"update ingestion_private.law_source_paths set closed_at=greatest(statement_timestamp(),opened_at), last_commit_sha=$2 where law_id=$1 and closed_at is null",
			[law.id, commit],
		);
	}
	async openPath(law: Law, commit: string): Promise<void> {
		await this.client.query(
			"insert into ingestion_private.law_source_paths(law_id,source_path,first_commit_sha,last_commit_sha,is_primary) values($1,$2,$3,$3,true)",
			[law.id, law.source_path, commit],
		);
	}
	async remove(law: Law, commit: string): Promise<void> {
		if (!law.source_removed_at)
			await this.client.query(
				"update public.laws set source_removed_at=statement_timestamp() where id=$1",
				[law.id],
			);
		await this.closePath(law, commit);
	}
	async finish(
		run: Run,
		counters: unknown,
		complete: boolean,
		success: boolean,
	): Promise<void> {
		await this.transaction(async () => {
			await this.client.query(
				"update ingestion_private.runs set status=$2,inventory_complete=$3,counters=$4,finished_at=greatest(statement_timestamp(),started_at) where id=$1",
				[
					run.id,
					success ? "completed" : "failed",
					complete,
					JSON.stringify(counters),
				],
			);
			if (success) {
				const checkpoint = await this.client.query(
					`insert into ingestion_private.checkpoints(repository,run_id,commit_sha) values($1,$2,$3)
    on conflict(repository) do update set run_id=excluded.run_id,commit_sha=excluded.commit_sha where ingestion_private.checkpoints.commit_sha=$4`,
					[REPOSITORY, run.id, run.target_commit_sha, run.base_commit_sha],
				);
				if (checkpoint.rowCount !== 1)
					throw new IngestionError(
						"checkpoint_race",
						"Checkpoint alterado durante execução",
					);
			}
		});
	}
}
