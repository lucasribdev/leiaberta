import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	type Entry,
	IngestionError,
	LIMITS,
	REPOSITORY,
	type Snapshot,
} from "./model.ts";

const exec = promisify(execFile);
export async function git(
	directory: string,
	args: string[],
	maxBuffer = LIMITS.gitOutput,
): Promise<Buffer> {
	const { stdout } = await exec(
		"git",
		[
			"--no-replace-objects",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"protocol.file.allow=never",
			"-c",
			"protocol.ext.allow=never",
			"-C",
			directory,
			...args,
		],
		{
			encoding: "buffer",
			maxBuffer,
			timeout: LIMITS.timeoutMs,
			env: {
				PATH: process.env.PATH,
				HOME: tmpdir(),
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_TERMINAL_PROMPT: "0",
				GIT_LFS_SKIP_SMUDGE: "1",
			},
		},
	);
	return stdout;
}
export class GitSnapshot implements Snapshot {
	directory: string;
	commit: string;
	constructor(directory: string, commit: string) {
		this.directory = directory;
		this.commit = commit;
		if (!/^[a-f0-9]{40}$/.test(commit))
			throw new IngestionError("invalid_commit", "Commit inválido");
	}
	async inventory(commit: string): Promise<Entry[]> {
		if (!/^[a-f0-9]{40}$/.test(commit))
			throw new IngestionError("invalid_commit", "Commit inválido");
		const bytes = await git(this.directory, [
			"ls-tree",
			"-rlz",
			"--full-tree",
			commit,
		]);
		const output = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (output && !output.endsWith("\0"))
			throw new IngestionError(
				"incomplete_inventory",
				"Inventário Git incompleto",
			);
		const entries = output
			.split("\0")
			.filter(Boolean)
			.map((line) => {
				const m = /^(\d{6}) (blob|commit) ([a-f0-9]{40}) +([\d-]+)\t(.+)$/.exec(
					line,
				);
				if (!m)
					throw new IngestionError("invalid_tree", "Entrada Git inválida");
				return {
					path: m[5],
					mode: m[1],
					blob: m[3],
					size: m[4] === "-" ? 0 : Number(m[4]),
				};
			});
		if (entries.length > LIMITS.files)
			throw new IngestionError("inventory_limit", "Inventário excede limite");
		return entries;
	}
	async read(entry: Entry): Promise<Buffer> {
		if (
			entry.mode !== "100644" ||
			entry.size > LIMITS.fileBytes ||
			!/^[a-f0-9]{40}$/.test(entry.blob)
		)
			throw new IngestionError(
				"unsafe_blob",
				"Tipo ou tamanho de blob não permitido",
			);
		const bytes = await git(
			this.directory,
			["cat-file", "blob", entry.blob],
			LIMITS.fileBytes + 1,
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
	}
}
export async function acquire(
	reference: string,
): Promise<{ snapshot: GitSnapshot; dispose(): Promise<void> }> {
	if (
		!/^[a-zA-Z0-9][a-zA-Z0-9/._-]{0,199}$/.test(reference) ||
		reference.includes("..")
	)
		throw new IngestionError("invalid_ref", "Referência inválida");
	const directory = await mkdtemp(join(tmpdir(), "leiaberta-git-"));
	try {
		await git(directory, ["init", "--bare"]);
		// A single fetch resolves the requested ref. All later operations use FETCH_HEAD's commit.
		// No checkout, hooks, submodule initialization, source scripts or YAML URLs.
		await git(directory, [
			"fetch",
			"--depth=1",
			"--no-tags",
			`${REPOSITORY}.git`,
			reference,
		]);
		const commit = (
			await git(directory, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"])
		)
			.toString()
			.trim();
		return {
			snapshot: new GitSnapshot(directory, commit),
			dispose: () => rm(directory, { recursive: true, force: true }),
		};
	} catch {
		await rm(directory, { recursive: true, force: true });
		throw new IngestionError(
			"acquisition_failed",
			"Aquisição Git falhou; nenhum checkpoint avançado",
		);
	}
}
