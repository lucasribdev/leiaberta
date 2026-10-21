import { createBrowserClient } from "@supabase/ssr";
import { createClientOnlyFn } from "@tanstack/react-start";
import type { Database } from "./database.types";
import { getSupabaseEnv } from "./env.ts";

// @supabase/ssr reuses the browser client; never call this during SSR.
export const createClient = createClientOnlyFn(() => {
	const env = getSupabaseEnv();
	return createBrowserClient<Database>(
		env.VITE_SUPABASE_URL,
		env.VITE_SUPABASE_PUBLISHABLE_KEY,
	);
});
