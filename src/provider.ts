import { CUSTOM_API_ID, streamCopilotGateway } from "./gateway-client";
import { observe } from "./observability";
import { loadOfficialCopilotSupport } from "./official-copilot";

export const PROVIDER_ID = "github-copilot";
const DEFAULT_GATEWAY_BASE_URL = process.env.OMP_COPILOT_GATEWAY_BASE_URL || "http://127.0.0.1:8787";

type ExtensionApiLike = {
	pi?: {
		discoverAuthStorage?: () => Promise<{ getOAuthCredential(provider: string): { access: string; enterpriseUrl?: string } | undefined }>;
	};
	registerProvider(name: string, config: Record<string, unknown>): void;
};

async function resolveOfficialCopilotBaseUrl(api: ExtensionApiLike, fallbackBaseUrl: string) {
	const support = await loadOfficialCopilotSupport();
	const authStorage = await api.pi?.discoverAuthStorage?.().catch(() => undefined);
	const credential = authStorage?.getOAuthCredential(PROVIDER_ID);
	const baseUrl = credential
		? support.getGitHubCopilotBaseUrl(credential.access, credential.enterpriseUrl)
		: fallbackBaseUrl;
	observe("provider.base_url_resolved", {
		provider: PROVIDER_ID,
		hasCredential: Boolean(credential),
		hasEnterpriseUrl: Boolean(credential?.enterpriseUrl),
		baseUrl,
	});
	return baseUrl;
}

async function buildOfficialCopilotModels() {
	const support = await loadOfficialCopilotSupport();
	const models = support.getBundledModels(PROVIDER_ID).map(model => ({
		id: model.id,
		name: model.name,
		api: CUSTOM_API_ID,
		reasoning: model.reasoning,
		input: [...model.input],
		cost: { ...model.cost },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		headers: {
			...(model.headers ?? {}),
			"X-Copilot-Behavioral-Reference": "vscode-copilot-chat",
		},
		compat: model.compat,
	}));
	observe("provider.models_loaded", {
		provider: PROVIDER_ID,
		count: models.length,
		sample: models.slice(0, 5).map(model => model.id),
	});
	return models;
}

async function createOfficialCopilotOAuthBridge() {
	const support = await loadOfficialCopilotSupport();
	return {
		name: "GitHub Copilot",
		async login(callbacks: {
			onAuth(info: { url: string; instructions?: string }): void;
			onPrompt(prompt: { message: string; placeholder?: string; allowEmpty?: boolean }): Promise<string>;
			onProgress?(message: string): void;
			signal?: AbortSignal;
		}) {
			return support.loginGitHubCopilot({
				onAuth(url, instructions) {
					callbacks.onAuth({ url, instructions });
				},
				onPrompt: callbacks.onPrompt,
				onProgress: callbacks.onProgress,
				signal: callbacks.signal,
			});
		},
		getApiKey(credentials: { access: string }) {
			return credentials.access;
		},
		async refreshToken(credentials: { refresh: string; enterpriseUrl?: string }) {
			return support.refreshGitHubCopilotToken(credentials.refresh, credentials.enterpriseUrl);
		},
	};
}

export async function registerCopilotGatewayProvider(api: ExtensionApiLike) {
	const [baseUrl, models, oauth] = await Promise.all([
		resolveOfficialCopilotBaseUrl(api, DEFAULT_GATEWAY_BASE_URL),
		buildOfficialCopilotModels(),
		createOfficialCopilotOAuthBridge(),
	]);
	observe("provider.register", {
		provider: PROVIDER_ID,
		api: CUSTOM_API_ID,
		baseUrl,
		modelCount: models.length,
	});

	api.registerProvider(PROVIDER_ID, {
		api: CUSTOM_API_ID,
		baseUrl,
		authHeader: false,
		models,
		oauth,
		streamSimple: streamCopilotGateway,
	});
}