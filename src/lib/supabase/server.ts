import { createServerClient } from "@supabase/ssr";
import { createServerOnlyFn } from "@tanstack/react-start";
import {
	getCookies,
	setCookie,
	setResponseHeader,
} from "@tanstack/react-start/server";
import type { Database } from "./database.types";
import { getSupabaseEnv } from "./env.ts";

// A fresh client per request prevents session and cache-header leakage.
export const createClient = createServerOnlyFn(() => {
	const env = getSupabaseEnv();
	return createServerClient<Database>(
		env.VITE_SUPABASE_URL,
		env.VITE_SUPABASE_PUBLISHABLE_KEY,
		{
			cookies: {
				getAll() {
					return Object.entries(getCookies()).map(([name, value]) => ({
						name,
						value,
					}));
				},
				setAll(cookies, headers) {
					cookies.forEach(({ name, value, options }) => {
						setCookie(name, value, options);
					});

					Object.entries(headers).forEach(([name, value]) => {
						setResponseHeader(name, value);
					});
				},
			},
		},
	);
});
