import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { IngestionError } from "./model.ts";

// Operational budgets do not change parser/configuration semantics.
export const FULL_LIMITS = {
	durationMs: 2 * 60 * 60 * 1000,
	acquisitionMs: 5 * 60 * 1000,
	diskBytes: 1024 * 1024 * 1024,
	rssBytes: 768 * 1024 * 1024,
	readBytes: 2 * 1024 * 1024 * 1024,
	reportBytes: 64 * 1024 * 1024,
	pollMs: 100,
};

export class Budget {
	readonly controller = new AbortController();
	readonly started = Date.now();
	readonly limits: typeof FULL_LIMITS;
	readBytes = 0;
	reportBytes = 0;
	peakRssBytes = 0;
	peakDiskBytes = 0;
	directory?: string;
	childPid?: number;
	private timer?: ReturnType<typeof setInterval>;
	private pending?: Promise<void>;
	failure?: IngestionError;

	constructor(limits = FULL_LIMITS) {
		this.limits = limits;
	}
	stop(code: string, message: string): void {
		this.failure ??= new IngestionError(code, message);
		this.controller.abort();
		this.killChild();
	}
	killChild(): void {
		if (!this.childPid) return;
		try {
			process.kill(-this.childPid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
	assert(): void {
		if (Date.now() - this.started >= this.limits.durationMs)
			this.stop("duration_limit", "Prazo total excedido");
		if (this.failure) throw this.failure;
	}
	consume(kind: "readBytes" | "reportBytes", bytes: number): void {
		this.assert();
		if (this[kind] + bytes > this.limits[kind]) {
			this.stop(`${kind}_limit`, `Orçamento ${kind} excedido`);
			this.assert();
		}
		this[kind] += bytes;
	}
	async measure(): Promise<void> {
		this.assert();
		let rss = process.memoryUsage().rss;
		const childRss = async (pid: number): Promise<number> => {
			try {
				const status = await readFile(`/proc/${pid}/status`, "utf8");
				const children = await readFile(
					`/proc/${pid}/task/${pid}/children`,
					"utf8",
				);
				let bytes = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024;
				for (const child of children.trim().split(/\s+/).filter(Boolean))
					bytes += await childRss(Number(child));
				return bytes;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				return 0;
			}
		};
		if (this.childPid) rss += await childRss(this.childPid);
		this.peakRssBytes = Math.max(this.peakRssBytes, rss);
		if (rss > this.limits.rssBytes)
			this.stop("memory_limit", "RSS observado excedeu o orçamento");
		if (this.directory) {
			const walk = async (path: string): Promise<number> => {
				let bytes = 0;
				const entries = await readdir(path, { withFileTypes: true }).catch(
					(error) => {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
						throw error;
					},
				);
				for (const entry of entries) {
					const child = join(path, entry.name);
					bytes += entry.isDirectory()
						? await walk(child)
						: await stat(child)
								.then((s) => s.size)
								.catch((error) => {
									if ((error as NodeJS.ErrnoException).code === "ENOENT")
										return 0;
									throw error;
								});
				}
				return bytes;
			};
			const bytes = await walk(this.directory);
			this.peakDiskBytes = Math.max(this.peakDiskBytes, bytes);
			if (bytes > this.limits.diskBytes)
				this.stop(
					"disk_limit",
					"Disco temporário observado excedeu o orçamento",
				);
		}
		this.assert();
	}
	async start(): Promise<void> {
		// Child RSS observation requires Linux procfs; fail before acquisition elsewhere.
		await readFile(`/proc/${process.pid}/status`);
		await this.measure();
		this.timer = setInterval(() => {
			if (this.pending) return;
			this.pending = this.measure()
				.catch((error) => {
					if (!this.failure)
						this.stop(
							"resource_monitor",
							error instanceof IngestionError
								? error.message
								: "Monitor de recursos falhou",
						);
				})
				.finally(() => {
					this.pending = undefined;
				});
		}, this.limits.pollMs);
	}
	async close(): Promise<void> {
		clearInterval(this.timer);
		await this.pending;
	}
	metrics() {
		return {
			elapsedMs: Date.now() - this.started,
			readBytes: this.readBytes,
			reportBytes: this.reportBytes,
			peakRssBytes: this.peakRssBytes,
			peakDiskBytes: this.peakDiskBytes,
		};
	}
}
