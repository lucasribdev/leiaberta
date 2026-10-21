import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { GitSnapshot } from "../../scripts/ingestion/git.ts";
import { LIMITS, sha256 } from "../../scripts/ingestion/model.ts";
import { archiveTo, ingest } from "../../scripts/ingestion/runner.ts";
import { fixture, PATH } from "./fixtures.ts";

const exec = promisify(execFile);

test("snapshot Git sintético fixa commit, inventário completo, blob e hash; não segue symlink", async () => {
	const root = await mkdtemp(join(tmpdir(), "la005-git-"));
	const git = (...args: string[]) =>
		exec("git", ["-c", "core.hooksPath=/dev/null", "-C", root, ...args], {
			env: {
				...process.env,
				GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
				GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
				GIT_AUTHOR_NAME: "Fixture",
				GIT_AUTHOR_EMAIL: "fixture@example.invalid",
				GIT_COMMITTER_NAME: "Fixture",
				GIT_COMMITTER_EMAIL: "fixture@example.invalid",
			},
		});
	try {
		await git("init");
		await mkdir(dirname(join(root, PATH)), { recursive: true });
		await writeFile(join(root, PATH), fixture());
		await symlink(
			"/etc/passwd",
			join(root, "federal/leis-ordinarias/2002/link.md"),
		);
		await git("add", ".");
		await git("commit", "-m", "Synthetic fixture");
		const commit = (await git("rev-parse", "HEAD")).stdout.trim();
		const source = new GitSnapshot(root, commit);
		const inventory = await source.inventory(commit);
		assert.equal(inventory.length, 2);
		const entry = inventory.find((e) => e.path === PATH);
		assert.ok(entry);
		assert.equal(sha256(await source.read(entry)), sha256(fixture()));
		await assert.rejects(
			source.read({ ...entry, size: entry.size + 1 }),
			/divergente/,
		);
		await assert.rejects(
			source.read({ ...entry, size: LIMITS.fileBytes + 1 }),
			/permitido/,
		);
		const link = inventory.find((e) => e.mode === "120000");
		assert.ok(link);
		await assert.rejects(source.read(link), /permitido/);
		await writeFile(join(root, PATH), fixture({ ementa: "Nova versão" }));
		await git("add", PATH);
		await git("commit", "-m", "Changed branch");
		assert.equal(
			sha256(await source.read(entry)),
			sha256(fixture()),
			"original immutable snapshot remains readable",
		);
		const report = await ingest(source);
		assert.equal(report.inserted, 1);
		assert.equal(report.failed, 1);
		assert.equal(report.inventoried, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("arquivo por hash preserva bytes originais e detecta corrupção", async () => {
	const root = await mkdtemp(join(tmpdir(), "la005-archive-"));
	try {
		const bytes = fixture();
		const archive = archiveTo(root);
		const reference = await archive(bytes);
		assert.equal(reference, `sha256:${sha256(bytes)}`);
		assert.equal(await archive(bytes), reference);
		await writeFile(join(root, sha256(bytes)), "corrupt");
		await assert.rejects(archive(bytes), /divergente/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
