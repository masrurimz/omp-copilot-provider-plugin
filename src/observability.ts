import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

const OBSERVE_FLAG = "OMP_COPILOT_PROVIDER_OBSERVE";
const OBSERVE_STDERR_FLAG = "OMP_COPILOT_PROVIDER_OBSERVE_STDERR";
const OBSERVE_FILE_FLAG = "OMP_COPILOT_PROVIDER_OBSERVE_FILE";
const DEFAULT_LOG_FILE = `${homedir()}/.omp/logs/copilot-provider-observe.ndjson`;

type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

function isSecretKey(key: string): boolean {
	return /authorization|api[_-]?key|token|secret|password|access|refresh/i.test(key);
}

function sanitize(value: unknown, depth = 0): JsonLike {
	if (depth > 4) return "[truncated]";
	if (value === null) return null;
	if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}…` : value;
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.slice(0, 25).map(item => sanitize(item, depth + 1));
	if (typeof value !== "object") return String(value);

	const output: Record<string, JsonLike> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		output[key] = isSecretKey(key) ? "[redacted]" : sanitize(entry, depth + 1);
	}
	return output;
}

export function isObservabilityEnabled(): boolean {
	return process.env[OBSERVE_FLAG] === "1";
}

export function getObservabilityLogFile(): string {
	return process.env[OBSERVE_FILE_FLAG]?.trim() || DEFAULT_LOG_FILE;
}

export function observe(event: string, details?: unknown): void {
	if (!isObservabilityEnabled()) return;
	const record = {
		ts: new Date().toISOString(),
		pid: process.pid,
		event,
		details: sanitize(details),
	};
	const line = JSON.stringify(record);
	try {
		const file = getObservabilityLogFile();
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `${line}\n`, "utf8");
	} catch {}
	if (process.env[OBSERVE_STDERR_FLAG] === "1") {
		console.error(`[omp-copilot-provider] ${line}`);
	}
}