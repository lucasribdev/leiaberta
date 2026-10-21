import { execFileSync } from "node:child_process";
import { renameSync, rmSync, writeFileSync } from "node:fs";

// Generate atomically: a failed CLI command must not truncate committed types.
const target = "src/lib/supabase/database.types.ts";
const temporary = `${target}.tmp`;
try {
	const types = execFileSync(
		"supabase",
		["gen", "types", "typescript", "--local", "--schema", "public"],
		{ encoding: "utf8" },
	);
	const formatted = execFileSync(
		"biome",
		["format", "--stdin-file-path", target],
		{ input: types, encoding: "utf8" },
	);
	writeFileSync(temporary, formatted);
	renameSync(temporary, target);
} finally {
	rmSync(temporary, { force: true });
}
