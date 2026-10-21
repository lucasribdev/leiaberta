import { z } from "zod";

const publicEnvSchema = z.object({
	VITE_SUPABASE_URL: z.url().refine((value) => /^https?:\/\//.test(value)),
	VITE_SUPABASE_PUBLISHABLE_KEY: z
		.string()
		.trim()
		.min(1)
		.refine((value) => {
			if (value.startsWith("sb_publishable_")) return true;
			// The local CLI may still supply a legacy anon JWT. Never accept service_role.
			try {
				const payload = value.split(".")[1];
				return (
					JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")))
						.role === "anon"
				);
			} catch {
				return false;
			}
		}),
});

export function parseSupabaseEnv(input: unknown) {
	const result = publicEnvSchema.safeParse(input);
	if (!result.success) {
		const fields = [
			...new Set(result.error.issues.map((issue) => issue.path.join("."))),
		];
		// Do not include input values: a misconfigured key could be a secret.
		throw new Error(
			`Configuração Supabase inválida: ${fields.join(", ")}. Consulte .env.example.`,
		);
	}
	return result.data;
}

export function getSupabaseEnv() {
	return parseSupabaseEnv(import.meta.env);
}
