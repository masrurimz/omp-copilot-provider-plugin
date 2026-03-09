import { registerCopilotGatewayProvider } from "./provider";
import { getObservabilityLogFile, isObservabilityEnabled, observe } from "./observability";

export default async function copilotGatewayExtension(pi: {
  setLabel?(label: string): void;
	pi?: { discoverAuthStorage?: () => Promise<unknown> };
  registerProvider(name: string, config: Record<string, unknown>): void;
}) {
  observe("extension.load", {
		observabilityEnabled: isObservabilityEnabled(),
		logFile: getObservabilityLogFile(),
	});
  pi.setLabel?.("Copilot Gateway Provider");
	try {
		await registerCopilotGatewayProvider(pi);
	} catch (error) {
		observe("extension.register_failed", {
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
		throw error;
	}
  return {
    name: "copilot-gateway-provider",
    description: "Registers a custom GitHub Copilot gateway provider path for OMP.",
  };
}