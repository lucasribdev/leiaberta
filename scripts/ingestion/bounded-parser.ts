import { Worker } from "node:worker_threads";
import { IngestionError, LIMITS } from "./model.ts";
import type { parseLaw } from "./parser.ts";

// Source parsing has a hard deadline and a separate heap. It receives only bytes
// and a path, with no database/network credentials in its environment.
export async function parseLawBounded(
	bytes: Buffer,
	path: string,
): Promise<ReturnType<typeof parseLaw>> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL("./parser-worker.ts", import.meta.url), {
			workerData: { bytes, path },
			env: {},
			execArgv: [],
			resourceLimits: {
				maxOldGenerationSizeMb: 64,
				maxYoungGenerationSizeMb: 16,
				stackSizeMb: 4,
			},
		});
		const timer = setTimeout(() => {
			void worker.terminate();
			reject(new IngestionError("parser_timeout", "Tempo de parsing excedido"));
		}, LIMITS.parseTimeoutMs);
		worker.once("message", (message) => {
			clearTimeout(timer);
			void worker.terminate();
			if (message.error)
				reject(new IngestionError(message.error.code, message.error.message));
			else resolve(message.result);
		});
		worker.once("error", () => {
			clearTimeout(timer);
			reject(
				new IngestionError(
					"parser_failed",
					"Parser excedeu recursos ou falhou",
				),
			);
		});
		worker.once("exit", (code) => {
			clearTimeout(timer);
			if (code !== 0)
				reject(new IngestionError("parser_failed", "Parser interrompido"));
		});
	});
}
