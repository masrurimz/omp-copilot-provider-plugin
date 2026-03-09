import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import extension from "../src/extension";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..");
	const tempDir = mkdtempSync(path.join(tmpdir(), "omp-copilot-provider-"));

  process.env.OMP_COPILOT_GATEWAY_MOCK ||= "1";
  process.env.OMP_COPILOT_GATEWAY_BASE_URL ||= "mock://local";

  try {
		const { AuthCredentialStore, AuthStorage } = await import("../../oh-my-pi/packages/ai/src/auth-storage.ts");
		const { ModelRegistry } = await import("../../oh-my-pi/packages/coding-agent/src/config/model-registry.ts");
		const dbPath = path.join(tempDir, "agent.db");
		const store = await AuthCredentialStore.open(dbPath);
		const authStorage = new AuthStorage(store);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		await authStorage.set("github-copilot", {
			type: "oauth",
			access: "copilot_access_token",
			refresh: "copilot_refresh_token",
			expires: Date.now() + 60_000,
		});

		await extension({
			pi: {
				async discoverAuthStorage() {
					return authStorage;
				},
			},
			setLabel(label: string) {
				console.log(`label=${label}`);
			},
			registerProvider(name: string, config: Record<string, unknown>) {
				modelRegistry.registerProvider(name, config as never, "local-dev-plugin");
			},
		});

		const model = modelRegistry.find("github-copilot-vscode", "claude-haiku-4.5");
		assert(model, "OMP ModelRegistry did not register the custom provider model.");
		const mirrored = authStorage.getOAuthCredential("github-copilot-vscode");
		assert(mirrored?.access === "copilot_access_token", "Official Copilot OAuth was not mirrored into the custom provider.");
		const available = modelRegistry.getAvailable().some(entry => entry.provider === "github-copilot-vscode");
		assert(available, "Custom provider model is not reported as available by OMP ModelRegistry.");
		const apiKey = await modelRegistry.getApiKey(model, "verify-omp");
		assert(apiKey === "copilot_access_token", "Provider API key resolution did not use Copilot OAuth credentials.");
			await modelRegistry.refresh("never");
			const refreshedModel = modelRegistry.find("github-copilot-vscode", "claude-haiku-4.5");
			assert(refreshedModel, "Custom provider model disappeared after ModelRegistry.refresh().");
			const refreshedAvailable = modelRegistry.getAvailable().some(entry => entry.provider === "github-copilot-vscode");
			assert(refreshedAvailable, "Custom provider model is not available after ModelRegistry.refresh().");

    console.log(
      JSON.stringify(
        {
					provider: model.provider,
					model: model.id,
					api: model.api,
					baseUrl: model.baseUrl,
					modelCount: modelRegistry.getAll().filter(entry => entry.provider === "github-copilot-vscode").length,
					available,
					availableAfterRefresh: refreshedAvailable,
					apiKeyResolved: Boolean(apiKey),
        },
        null,
        2,
      ),
    );
  } finally {
		rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});