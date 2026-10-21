import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { CookieMethodsServer, CookieOptions } from "@supabase/ssr";

const env = {
	VITE_SUPABASE_URL: "http://127.0.0.1:54321",
	VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
};
const cookieWrites = mock.fn();
const headerWrites = mock.fn();
const serverFactory = mock.fn(
	(_url: string, _key: string, options: { cookies: CookieMethodsServer }) => ({
		options,
	}),
);
const browserFactory = mock.fn(() => ({}));
mock.module("@supabase/ssr", {
	namedExports: {
		createServerClient: serverFactory,
		createBrowserClient: browserFactory,
	},
});
mock.module("@tanstack/react-start", {
	namedExports: {
		createServerOnlyFn: (fn: unknown) => fn,
		createClientOnlyFn: (fn: unknown) => fn,
	},
});
mock.module("@tanstack/react-start/server", {
	namedExports: {
		getCookies: () => ({
			"sb-session.0": "first",
			"sb-session.1": "second",
			other: "value",
		}),
		setCookie: cookieWrites,
		setResponseHeader: headerWrites,
	},
});
mock.module("../src/lib/supabase/env.ts", {
	namedExports: { getSupabaseEnv: () => env },
});

const server = await import("../src/lib/supabase/server.ts");
const browser = await import("../src/lib/supabase/client.ts");

test("SSR creates a fresh client and forwards all cookie chunks and cache headers", async () => {
	assert.notEqual(server.createClient(), server.createClient());
	assert.equal(serverFactory.mock.callCount(), 2);
	const [url, key, options] = serverFactory.mock.calls[0].arguments;
	assert.equal(url, env.VITE_SUPABASE_URL);
	assert.equal(key, env.VITE_SUPABASE_PUBLISHABLE_KEY);
	assert.ok(options.cookies.getAll);
	assert.ok(options.cookies.setAll);
	assert.deepEqual(await options.cookies.getAll(), [
		{ name: "sb-session.0", value: "first" },
		{ name: "sb-session.1", value: "second" },
		{ name: "other", value: "value" },
	]);
	const cookieOptions: CookieOptions = {
		path: "/",
		sameSite: "lax",
		secure: true,
		maxAge: 0,
	};
	await options.cookies.setAll(
		[
			{ name: "sb-session.0", value: "new", options: { path: "/" } },
			{ name: "sb-session.1", value: "", options: cookieOptions },
		],
		{ "Cache-Control": "private, no-store", Expires: "0", Pragma: "no-cache" },
	);
	assert.equal(cookieWrites.mock.callCount(), 2);
	assert.deepEqual(cookieWrites.mock.calls[1].arguments, [
		"sb-session.1",
		"",
		cookieOptions,
	]);
	assert.deepEqual(
		headerWrites.mock.calls.map((call) => call.arguments),
		[
			["Cache-Control", "private, no-store"],
			["Expires", "0"],
			["Pragma", "no-cache"],
		],
	);
});

test("browser client receives only validated public configuration", () => {
	browser.createClient();
	assert.deepEqual(browserFactory.mock.calls[0].arguments, [
		env.VITE_SUPABASE_URL,
		env.VITE_SUPABASE_PUBLISHABLE_KEY,
	]);
});
