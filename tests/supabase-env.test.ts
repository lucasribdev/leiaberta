import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSupabaseEnv } from "../src/lib/supabase/env.ts";

const env = {
	VITE_SUPABASE_URL: "http://127.0.0.1:54321",
	VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
};
const jwt = (role: string) =>
	`header.${btoa(JSON.stringify({ role }))}.signature`;

test("accepts public configuration and local legacy anon keys", () => {
	assert.deepEqual(parseSupabaseEnv(env), env);
	assert.equal(
		parseSupabaseEnv({ ...env, VITE_SUPABASE_PUBLISHABLE_KEY: jwt("anon") })
			.VITE_SUPABASE_PUBLISHABLE_KEY,
		jwt("anon"),
	);
});

test("rejects missing/invalid configuration without leaking supplied values", () => {
	for (const key of ["", "sb_secret_do_not_print", jwt("service_role")]) {
		assert.throws(
			() => parseSupabaseEnv({ ...env, VITE_SUPABASE_PUBLISHABLE_KEY: key }),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /VITE_SUPABASE_PUBLISHABLE_KEY/);
				if (key) assert.ok(!error.message.includes(key));
				return true;
			},
		);
	}
	assert.throws(() => parseSupabaseEnv({}), /VITE_SUPABASE_URL/);
	assert.throws(() =>
		parseSupabaseEnv({ ...env, VITE_SUPABASE_URL: "ftp://example.invalid" }),
	);
});
