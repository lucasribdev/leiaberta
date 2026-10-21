import { parentPort, workerData } from "node:worker_threads";
import { IngestionError } from "./model.ts";
import { parseLaw } from "./parser.ts";

try {
	parentPort?.postMessage({
		result: parseLaw(Buffer.from(workerData.bytes), workerData.path),
	});
} catch (error) {
	parentPort?.postMessage({
		error: {
			code: error instanceof IngestionError ? error.code : "invalid_document",
			message:
				error instanceof IngestionError ? error.message : "Documento inválido",
		},
	});
}
