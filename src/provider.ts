import { CUSTOM_API_ID, streamCopilotGateway } from "./gateway-client";
import { observe } from "./observability";
import { loadOfficialCopilotSupport } from "./official-copilot";

export const PROVIDER_ID = "github-copilot-vscode";
const OFFICIAL_PROVIDER_ID = "github-copilot";
const DEFAULT_GATEWAY_BASE_URL = process.env.OMP_COPILOT_GATEWAY_BASE_URL || "http://127.0.0.1:8787";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

const MODELS = [
	{
		id: "claude-haiku-4.5",
		name: "Copilot Claude Haiku 4.5",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 128_000,
		maxTokens: 32_000,
		premiumMultiplier: 0.33,
	},
	{
		id: "claude-opus-4.5",
		name: "Copilot Claude Opus 4.5",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 128_000,
		maxTokens: 32_000,
		premiumMultiplier: 1,
	},
	{
		id: "claude-opus-4.6",
		name: "Copilot Claude Opus 4.6",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 200_000,
		maxTokens: 64_000,
		premiumMultiplier: 3,
	},
	{
		id: "claude-sonnet-4",
		name: "Copilot Claude Sonnet 4",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 128_000,
		maxTokens: 16_000,
		premiumMultiplier: 1,
	},
	{
		id: "claude-sonnet-4.5",
		name: "Copilot Claude Sonnet 4.5",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 128_000,
		maxTokens: 32_000,
		premiumMultiplier: 1,
	},
	{
		id: "claude-sonnet-4.6",
		name: "Copilot Claude Sonnet 4.6",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 200_000,
		maxTokens: 32_000,
		premiumMultiplier: 1,
	},
	{
		id: "gemini-2.5-pro",
		name: "Copilot Gemini 2.5 Pro",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 128_000,
		maxTokens: 64_000,
		premiumMultiplier: 1,
	},
	{
		id: "gemini-3-flash-preview",
		name: "Copilot Gemini 3 Flash Preview",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 128_000,
		maxTokens: 64_000,
		premiumMultiplier: 1,
	},
	{
		id: "gemini-3-pro-preview",
		name: "Copilot Gemini 3 Pro Preview",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 128_000,
		maxTokens: 64_000,
		premiumMultiplier: 1,
	},
	{
		id: "gemini-3.1-pro-preview",
		name: "Copilot Gemini 3.1 Pro Preview",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 128_000,
		maxTokens: 64_000,
		premiumMultiplier: 1,
	},
	{
		id: "gpt-4.1",
		name: "Copilot GPT-4.1",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 64_000,
		maxTokens: 16_384,
		premiumMultiplier: 1,
	},
	{
		id: "gpt-4o",
		name: "Copilot GPT-4o",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 64_000,
		maxTokens: 16_384,
		premiumMultiplier: 0,
	},
	{
		id: "gpt-5",
		name: "Copilot GPT-5",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 128_000,
		maxTokens: 128_000,
		premiumMultiplier: 1,
	},
	{
		id: "gpt-5-mini",
		name: "Copilot GPT-5 Mini",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 128_000,
		maxTokens: 64_000,
		premiumMultiplier: 1,
	},
	{
		id: "gpt-5.1",
		name: "Copilot GPT-5.1",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 128_000,
		maxTokens: 64_000,
		premiumMultiplier: 1,
	},
	{
		id: "gpt-5.1-codex",
		name: "Copilot GPT-5.1 Codex",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 272_000,
		maxTokens: 128_000,
		premiumMultiplier: 1,
	},
	{
		id: "gpt-5.1-codex-max",
		name: "Copilot GPT-5.1 Codex Max",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 272_000,
		maxTokens: 128_000,
		premiumMultiplier: 1,
	},
	{
		id: "gpt-5.1-codex-mini",
		name: "Copilot GPT-5.1 Codex Mini",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 272_000,
		maxTokens: 128_000,
		premiumMultiplier: 1,
	},
	{
		id: "gpt-5.2",
		name: "Copilot GPT-5.2",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 128_000,
		maxTokens: 64_000,
		premiumMultiplier: 1,
	},
	{
		id: "gpt-5.2-codex",
		name: "Copilot GPT-5.2 Codex",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 272_000,
		maxTokens: 128_000,
		premiumMultiplier: 1,
	},
	{
		id: "gpt-5.3-codex",
		name: "Copilot GPT-5.3 Codex",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 272_000,
		maxTokens: 128_000,
		premiumMultiplier: 1,
	},
	{
		id: "gpt-5.4",
		name: "Copilot GPT-5.4",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		premiumMultiplier: 1,
	},
	{
		id: "grok-code-fast-1",
		name: "Copilot Grok Code Fast 1",
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 64_000,
		premiumMultiplier: 0.25,
	},
] as const;

type ExtensionApiLike = {
	pi?: {
		discoverAuthStorage?: () => Promise<{
			getOAuthCredential(provider: string): { access: string; refresh: string; expires: number; enterpriseUrl?: string } | undefined;
			set?(provider: string, credential: Record<string, unknown>): Promise<void>;
		}>;
	};
	registerProvider(name: string, config: Record<string, unknown>): void;
};

async function mirrorOfficialCopilotAuth(api: ExtensionApiLike) {
	const authStorage = await api.pi?.discoverAuthStorage?.().catch(() => undefined);
	const source = authStorage?.getOAuthCredential(OFFICIAL_PROVIDER_ID);
	const target = authStorage?.getOAuthCredential(PROVIDER_ID);
	if (!authStorage?.set || !source) {
		observe("provider.auth_sync_skipped", {
			provider: PROVIDER_ID,
			hasAuthStorage: Boolean(authStorage),
			hasSourceCredential: Boolean(source),
		});
		return { authStorage, credential: target ?? source };
	}
	const needsSync =
		!target ||
		target.refresh !== source.refresh ||
		target.access !== source.access ||
		target.enterpriseUrl !== source.enterpriseUrl ||
		target.expires !== source.expires;
	if (needsSync) {
		await authStorage.set(PROVIDER_ID, { type: "oauth", ...source });
		observe("provider.auth_synced", {
			provider: PROVIDER_ID,
			fromProvider: OFFICIAL_PROVIDER_ID,
			hasEnterpriseUrl: Boolean(source.enterpriseUrl),
		});
	}
	return { authStorage, credential: authStorage.getOAuthCredential(PROVIDER_ID) ?? source };
}

async function resolveOfficialCopilotBaseUrl(api: ExtensionApiLike, fallbackBaseUrl: string) {
	const support = await loadOfficialCopilotSupport();
	const { credential } = await mirrorOfficialCopilotAuth(api);
	const baseUrl = credential ? support.getGitHubCopilotBaseUrl(credential.access, credential.enterpriseUrl) : fallbackBaseUrl;
	observe("provider.base_url_resolved", {
		provider: PROVIDER_ID,
		hasCredential: Boolean(credential),
		hasEnterpriseUrl: Boolean(credential?.enterpriseUrl),
		baseUrl,
	});
	return baseUrl;
}

async function resolveSessionApiKey(api: ExtensionApiLike) {
	const { credential } = await mirrorOfficialCopilotAuth(api);
	const apiKey = credential?.access;
	observe("provider.api_key_resolved", {
		provider: PROVIDER_ID,
		hasCredential: Boolean(credential),
		hasApiKey: Boolean(apiKey),
	});
	return apiKey;
}

function buildModels() {
	const models = MODELS.map(model => ({
		id: model.id,
		name: model.name,
		api: CUSTOM_API_ID,
		reasoning: model.reasoning,
		input: [...model.input],
			cost: { ...ZERO_COST },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
			premiumMultiplier: model.premiumMultiplier,
		headers: {
			"X-Copilot-Behavioral-Reference": "vscode-copilot-chat",
		},
	}));
	observe("provider.models_loaded", {
		provider: PROVIDER_ID,
		count: models.length,
		sample: models.map(model => model.id),
	});
	return models;
}

async function createOfficialCopilotOAuthBridge() {
	const support = await loadOfficialCopilotSupport();
	const enabledModelIds = MODELS.map(model => model.id);
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
			}, enabledModelIds);
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
	const [baseUrl, apiKey, models, oauth] = await Promise.all([
		resolveOfficialCopilotBaseUrl(api, DEFAULT_GATEWAY_BASE_URL),
		resolveSessionApiKey(api),
		Promise.resolve(buildModels()),
		createOfficialCopilotOAuthBridge(),
	]);
	observe("provider.register", {
		provider: PROVIDER_ID,
		api: CUSTOM_API_ID,
		baseUrl,
		hasApiKey: Boolean(apiKey),
		modelCount: models.length,
	});

	api.registerProvider(PROVIDER_ID, {
		api: CUSTOM_API_ID,
		baseUrl,
		...(apiKey ? { apiKey } : {}),
		authHeader: false,
		models,
		oauth,
		streamSimple: streamCopilotGateway,
	});
}