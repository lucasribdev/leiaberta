import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

// Capture the local CLI credential in memory and pass it only via the child's
// environment. Never print status output, the URL, or a driver error containing it.
try {
	let url = process.env.INGESTION_TEST_DATABASE_URL;
	if (!url) {
		const { stdout } = await promisify(execFile)(
			"node_modules/.bin/supabase",
			["status", "--output", "json"],
			{ timeout: 10000, maxBuffer: 1024 * 1024 },
		);
		url = JSON.parse(stdout).DB_URL;
	}
	if (!url) throw new Error("missing local connection");
	const child = spawn(
		process.execPath,
		["--test", "tests/ingestion/database.integration.ts"],
		{
			stdio: "inherit",
			env: { ...process.env, INGESTION_TEST_DATABASE_URL: url },
		},
	);
	child.once("error", () => {
		console.error("Não foi possível iniciar o teste local.");
		process.exitCode = 1;
	});
	child.once("exit", (code) => {
		process.exitCode = code ?? 1;
	});
} catch {
	console.error(
		"Não foi possível obter a conexão do Supabase local. Inicie o ambiente local ou injete INGESTION_TEST_DATABASE_URL por ambiente seguro.",
	);
	process.exitCode = 1;
}
