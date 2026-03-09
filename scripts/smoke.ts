import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import extension from "../src/extension";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  process.env.OMP_COPILOT_GATEWAY_MOCK ||= "1";
	process.env.OMP_COPILOT_PROVIDER_OBSERVE ||= "1";
	const tempDir = mkdtempSync(path.join(tmpdir(), "omp-copilot-provider-smoke-"));
	const observeFile = path.join(tempDir, "observe.ndjson");
	process.env.OMP_COPILOT_PROVIDER_OBSERVE_FILE = observeFile;

	try {
		let providerConfig: Record<string, any> | undefined;
		const pi = {
		pi: {
			async discoverAuthStorage() {
				return {
					getOAuthCredential() {
						return undefined;
					},
					async set() {},
				};
			},
		},
    setLabel(label: string) {
      console.log(`label=${label}`);
    },
    registerProvider(name: string, config: Record<string, unknown>) {
      providerConfig = { name, ...(config as object) } as Record<string, any>;
    },
		};

		const descriptor = await extension(pi);
		assert(descriptor.name === "copilot-gateway-provider", "Extension returned an unexpected descriptor name.");
		assert(providerConfig, "registerProvider was not called.");
		assert(providerConfig.name === "github-copilot-vscode", "Unexpected provider id.");
		assert(typeof providerConfig.streamSimple === "function", "Provider is missing streamSimple.");
		assert(Array.isArray(providerConfig.models) && providerConfig.models.length === 2, "Expected a small static custom model surface.");

		const stream = providerConfig.streamSimple(
			{
				id: "claude-haiku-4.5",
				provider: providerConfig.name,
				baseUrl: "mock://local",
				headers: {},
			},
			{
				system: "You are a smoke-test assistant.",
				messages: [{ role: "user", timestamp: Date.now(), content: "hello" }],
				tools: [],
			},
		{ sessionId: "smoke-session", apiKey: "mock-access-token" },
		);

		const events: string[] = [];
		for await (const event of stream) {
			events.push(event.type);
		}
		const result = await stream.result();
		const observeLog = readFileSync(observeFile, "utf8");
		assert(observeLog.includes("extension.load"), "Observability log did not record extension load.");
		assert(observeLog.includes("provider.register"), "Observability log did not record provider registration.");
		assert(observeLog.includes("transport.start"), "Observability log did not record transport start.");
		console.log(JSON.stringify({ provider: providerConfig.name, events, result, observeFile }, null, 2));
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});