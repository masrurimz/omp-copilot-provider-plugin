import { observe } from "./observability";

type OAuthCredentials = {
	refresh: string;
	access: string;
	expires: number;
	enterpriseUrl?: string;
	projectId?: string;
	email?: string;
	accountId?: string;
};

type OfficialCopilotSupport = {
	getGitHubCopilotBaseUrl(token?: string, enterpriseDomain?: string): string;
	loginGitHubCopilot(options: {
		onAuth: (url: string, instructions?: string) => void;
		onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
		onProgress?: (message: string) => void;
		signal?: AbortSignal;
	}, enabledModelIds?: string[]): Promise<OAuthCredentials>;
	refreshGitHubCopilotToken(token: string, enterpriseDomain?: string): Promise<OAuthCredentials>;
};

type DeviceCodeResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	interval: number;
	expires_in: number;
};

const decode = (value: string) => atob(value);
const CLIENT_ID = decode("SXYxLmI1MDdhMDhjODdlY2ZlOTg=");
const COPILOT_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
} as const;

let cachedSupport: Promise<OfficialCopilotSupport> | undefined;

function normalizeDomain(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	try {
		const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
		return url.hostname;
	} catch {
		return null;
	}
}

function getUrls(domain: string) {
	return {
		deviceCodeUrl: `https://${domain}/login/device/code`,
		accessTokenUrl: `https://${domain}/login/oauth/access_token`,
		copilotTokenUrl: `https://api.${domain}/copilot_internal/v2/token`,
	};
}

function getBaseUrlFromToken(token: string): string | null {
	const match = token.match(/proxy-ep=([^;]+)/);
	if (!match) return null;
	return `https://${match[1].replace(/^proxy\./, "api.")}`;
}

function getGitHubCopilotBaseUrl(token?: string, enterpriseDomain?: string): string {
	if (token) {
		const urlFromToken = getBaseUrlFromToken(token);
		if (urlFromToken) return urlFromToken;
	}
	if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
	return "https://api.individual.githubcopilot.com";
}

async function fetchJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`${response.status} ${response.statusText}: ${text}`);
	}
	const data = await response.json();
	if (!data || typeof data !== "object") throw new Error(`Invalid JSON response from ${url}`);
	return data as Record<string, unknown>;
}

async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw new Error("Login cancelled");
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Login cancelled"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function startDeviceFlow(domain: string): Promise<DeviceCodeResponse> {
	const data = await fetchJson(getUrls(domain).deviceCodeUrl, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"User-Agent": COPILOT_HEADERS["User-Agent"],
		},
		body: JSON.stringify({ client_id: CLIENT_ID, scope: "read:user" }),
	});
	const { device_code, user_code, verification_uri, interval, expires_in } = data;
	if (
		typeof device_code !== "string" ||
		typeof user_code !== "string" ||
		typeof verification_uri !== "string" ||
		typeof interval !== "number" ||
		typeof expires_in !== "number"
	) {
		throw new Error("Invalid device code response fields");
	}
	return { device_code, user_code, verification_uri, interval, expires_in };
}

async function pollForGitHubAccessToken(
	domain: string,
	deviceCode: string,
	intervalSeconds: number,
	expiresIn: number,
	signal?: AbortSignal,
): Promise<string> {
	const deadline = Date.now() + expiresIn * 1000;
	let intervalMs = Math.max(1000, Math.floor(intervalSeconds * 1000));
	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("Login cancelled");
		const raw = await fetchJson(getUrls(domain).accessTokenUrl, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"User-Agent": COPILOT_HEADERS["User-Agent"],
			},
			body: JSON.stringify({
				client_id: CLIENT_ID,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});
		if (typeof raw.access_token === "string") return raw.access_token;
		if (typeof raw.error === "string") {
			if (raw.error === "authorization_pending") {
				await abortableSleep(intervalMs, signal);
				continue;
			}
			if (raw.error === "slow_down") {
				intervalMs += 5000;
				await abortableSleep(intervalMs, signal);
				continue;
			}
			throw new Error(`Device flow failed: ${raw.error}`);
		}
		await abortableSleep(intervalMs, signal);
	}
	throw new Error("Device flow timed out");
}

async function refreshGitHubCopilotToken(refreshToken: string, enterpriseDomain?: string): Promise<OAuthCredentials> {
	const raw = await fetchJson(getUrls(enterpriseDomain || "github.com").copilotTokenUrl, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${refreshToken}`,
			...COPILOT_HEADERS,
		},
	});
	if (typeof raw.token !== "string" || typeof raw.expires_at !== "number") {
		throw new Error("Invalid Copilot token response fields");
	}
	return {
		refresh: refreshToken,
		access: raw.token,
		expires: raw.expires_at * 1000 - 5 * 60 * 1000,
		enterpriseUrl: enterpriseDomain,
	};
}

async function enableCopilotModels(token: string, modelIds: string[], enterpriseDomain?: string) {
	await Promise.all(
		modelIds.map(async modelId => {
			try {
				await fetch(`${getGitHubCopilotBaseUrl(token, enterpriseDomain)}/models/${modelId}/policy`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
						...COPILOT_HEADERS,
						"openai-intent": "chat-policy",
						"x-interaction-type": "chat-policy",
					},
					body: JSON.stringify({ state: "enabled" }),
				});
			} catch {}
		}),
	);
}

async function loginGitHubCopilot(
	options: Parameters<OfficialCopilotSupport["loginGitHubCopilot"]>[0],
	enabledModelIds: string[] = [],
): Promise<OAuthCredentials> {
	const input = await options.onPrompt({
		message: "GitHub Enterprise URL/domain (blank for github.com)",
		placeholder: "company.ghe.com",
		allowEmpty: true,
	});
	if (options.signal?.aborted) throw new Error("Login cancelled");
	const trimmed = input.trim();
	const enterpriseDomain = normalizeDomain(input);
	if (trimmed && !enterpriseDomain) throw new Error("Invalid GitHub Enterprise URL/domain");
	const domain = enterpriseDomain || "github.com";
	const device = await startDeviceFlow(domain);
	options.onAuth(device.verification_uri, `Enter code: ${device.user_code}`);
	const githubAccessToken = await pollForGitHubAccessToken(
		domain,
		device.device_code,
		device.interval,
		device.expires_in,
		options.signal,
	);
	const credentials = await refreshGitHubCopilotToken(githubAccessToken, enterpriseDomain ?? undefined);
	if (enabledModelIds.length > 0) {
		options.onProgress?.("Enabling models...");
		await enableCopilotModels(credentials.access, enabledModelIds, enterpriseDomain ?? undefined);
	}
	return credentials;
}

export function loadOfficialCopilotSupport(): Promise<OfficialCopilotSupport> {
	if (cachedSupport) return cachedSupport;
	cachedSupport = (async () => {
		try {
			observe("official_copilot.load_support.begin");
			observe("official_copilot.load_support.ready", { modelSource: "self-contained" });
			return {
				getGitHubCopilotBaseUrl,
				loginGitHubCopilot(options, enabledModelIds) {
					return loginGitHubCopilot(options, enabledModelIds);
				},
				refreshGitHubCopilotToken,
			};
		} catch (error) {
			observe("official_copilot.load_support.failed", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			throw error;
		}
	})();
	return cachedSupport;
}