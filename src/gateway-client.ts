import { createHash, randomUUID } from "node:crypto";
import { SimpleAssistantEventStream } from "./event-stream";
import { observe } from "./observability";

export const CUSTOM_API_ID = "omp-copilot-gateway-chat";
const PROVIDER_SESSION_STATE_KEY = "omp-copilot-gateway-provider";

type ModelLike = {
  id: string;
  provider: string;
  baseUrl?: string;
  headers?: Record<string, string>;
};

type MessageLike = {
  role: string;
  content?: unknown;
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  synthetic?: boolean;
};

type ContextLike = {
  messages: MessageLike[];
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  system?: string;
};

type StreamOptionsLike = {
  apiKey?: string;
  headers?: Record<string, string>;
  sessionId?: string;
  signal?: AbortSignal;
  providerSessionState?: Map<string, { close?: () => void }>;
  onPayload?: (payload: unknown) => void;
};

type ProviderTurnState = {
  conversationId: string;
  interactionId: string;
  agentTaskId: string;
  turnIndex: number;
  lastUserFingerprint?: string;
  close(): void;
};

type GatewayRequest = {
  provider: string;
  model: string;
  behavioralReference: "vscode-copilot-chat";
  session: {
    sessionId?: string;
    conversationId: string;
    interactionId: string;
    agentTaskId: string;
    turnIndex: number;
    initiator: "user" | "agent";
    isNewInteraction: boolean;
  };
  request: {
    system?: string;
    messages: unknown[];
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  };
};

type GatewayJsonResponse = {
  text?: string;
  stopReason?: "stop" | "length" | "toolUse";
  toolCalls?: Array<{ id?: string; name: string; arguments?: Record<string, unknown> }>;
};

function normalizeBaseUrl(value?: string): string {
  const base = value?.trim() || process.env.OMP_COPILOT_GATEWAY_BASE_URL || "http://127.0.0.1:8787";
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function isMockMode(baseUrl: string): boolean {
  return process.env.OMP_COPILOT_GATEWAY_MOCK === "1" || baseUrl.startsWith("mock://");
}

function summarizeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (record.type === "toolCall") return `[toolCall:${String(record.name ?? "unknown")}]`;
      if (record.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function fingerprintLatestUserMessage(messages: MessageLike[]): string {
  const latest = [...messages].reverse().find(message => message.role === "user");
  const raw = latest ? `${latest.timestamp ?? 0}:${summarizeContent(latest.content)}` : "no-user-message";
  return createHash("sha1").update(raw).digest("hex");
}

function getTurnState(sessionId: string | undefined, stateMap: StreamOptionsLike["providerSessionState"]): ProviderTurnState {
  const key = `${PROVIDER_SESSION_STATE_KEY}:${sessionId ?? "ephemeral"}`;
  const existing = stateMap?.get(key) as ProviderTurnState | undefined;
  if (existing) return existing;
  const created: ProviderTurnState = {
    conversationId: `conv_${sessionId ?? randomUUID()}`,
    interactionId: `interaction_${randomUUID()}`,
    agentTaskId: `task_${randomUUID()}`,
    turnIndex: 0,
    close() {},
  };
  stateMap?.set(key, created);
  return created;
}

function getInitiator(context: ContextLike, state: ProviderTurnState) {
  const latestFingerprint = fingerprintLatestUserMessage(context.messages ?? []);
  const isNewInteraction = latestFingerprint !== state.lastUserFingerprint;
  if (isNewInteraction) {
    state.interactionId = `interaction_${randomUUID()}`;
    state.agentTaskId = `task_${randomUUID()}`;
    state.turnIndex = 0;
    state.lastUserFingerprint = latestFingerprint;
  } else {
    state.turnIndex += 1;
  }
  return {
    initiator: (isNewInteraction ? "user" : "agent") as const,
    isNewInteraction,
    turnIndex: state.turnIndex,
  };
}

function serializeMessage(message: MessageLike): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    synthetic: message.synthetic,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    summary: summarizeContent(message.content),
  };
}

function buildGatewayRequest(model: ModelLike, context: ContextLike, options: StreamOptionsLike): GatewayRequest {
  const turnState = getTurnState(options.sessionId, options.providerSessionState);
  const turn = getInitiator(context, turnState);
	const payload = {
    provider: model.provider,
    model: model.id,
    behavioralReference: "vscode-copilot-chat",
    session: {
      sessionId: options.sessionId,
      conversationId: turnState.conversationId,
      interactionId: turnState.interactionId,
      agentTaskId: turnState.agentTaskId,
      turnIndex: turn.turnIndex,
      initiator: turn.initiator,
      isNewInteraction: turn.isNewInteraction,
    },
    request: {
      system: context.system,
      messages: (context.messages ?? []).map(serializeMessage),
      tools: (context.tools ?? []).map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    },
  };
	observe("transport.payload_built", {
		provider: payload.provider,
		model: payload.model,
		session: payload.session,
		messageCount: payload.request.messages.length,
		toolCount: payload.request.tools.length,
		hasSystem: Boolean(payload.request.system),
	});
	return payload;
}

function buildHeaders(model: ModelLike, options: StreamOptionsLike): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...model.headers,
    ...options.headers,
  });
  const token = options.apiKey || process.env.OMP_COPILOT_GATEWAY_API_KEY;
  if (token && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return headers;
}

function streamMockResponse(model: ModelLike, payload: GatewayRequest) {
	observe("transport.mock_response", {
		provider: model.provider,
		model: model.id,
		session: payload.session,
	});
  const stream = new SimpleAssistantEventStream(model.provider, model.id);
  queueMicrotask(() => {
    stream.appendText(
      [
        "Mock Copilot gateway provider response.",
        `initiator=${payload.session.initiator}`,
        `interaction=${payload.session.interactionId}`,
        `task=${payload.session.agentTaskId}`,
        `turn=${payload.session.turnIndex}`,
      ].join(" "),
    );
    stream.done("stop");
  });
  return stream;
}

function applyJsonResponse(stream: SimpleAssistantEventStream, response: GatewayJsonResponse): void {
	observe("transport.json_response", {
		stopReason: response.stopReason ?? "stop",
		textLength: response.text?.length ?? 0,
		toolCallCount: response.toolCalls?.length ?? 0,
	});
  if (response.text) {
    stream.appendText(response.text);
  }
  if (Array.isArray(response.toolCalls)) {
    for (const toolCall of response.toolCalls) {
      stream.addToolCall(toolCall.name, toolCall.arguments ?? {}, toolCall.id);
    }
    stream.done("toolUse");
    return;
  }
  stream.done(response.stopReason ?? "stop");
}

async function applySseResponse(stream: SimpleAssistantEventStream, response: Response): Promise<void> {
	observe("transport.sse_begin", {
		contentType: response.headers.get("content-type") ?? "",
		status: response.status,
	});
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Gateway returned an SSE response without a readable body.");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const dataLines = frame
        .split("\n")
        .map(line => line.trim())
        .filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trim());
      if (dataLines.length === 0) continue;
      const data = dataLines.join("\n");
      if (data === "[DONE]") {
	        observe("transport.sse_done", { reason: "stop" });
        stream.done("stop");
        return;
      }
      const event = JSON.parse(data) as { type?: string; delta?: string; text?: string; toolCall?: any; reason?: any; error?: string };
      if (event.type === "text_delta" && typeof event.delta === "string") {
        stream.appendText(event.delta);
      } else if (event.type === "tool_call" && event.toolCall?.name) {
	        observe("transport.sse_tool_call", { name: event.toolCall.name, id: event.toolCall.id });
        stream.addToolCall(event.toolCall.name, event.toolCall.arguments ?? {}, event.toolCall.id);
      } else if (event.type === "done") {
	        observe("transport.sse_done", { reason: event.reason ?? "stop" });
        stream.done(event.reason ?? "stop");
        return;
      } else if (event.type === "error") {
	        observe("transport.sse_error", { error: event.error ?? "Gateway SSE error event" });
        stream.fail("error", event.error ?? "Gateway SSE error event");
        return;
      } else if (typeof event.text === "string") {
        stream.appendText(event.text);
      }
    }
    if (done) break;
  }
  stream.done("stop");
}

export function streamCopilotGateway(model: ModelLike, context: ContextLike, options: StreamOptionsLike = {}) {
  const payload = buildGatewayRequest(model, context, options);
  options.onPayload?.(payload);
  const baseUrl = normalizeBaseUrl(model.baseUrl);
	observe("transport.start", {
		provider: model.provider,
		model: model.id,
		baseUrl,
		mock: isMockMode(baseUrl),
		sessionId: options.sessionId,
	});
  if (isMockMode(baseUrl)) {
    return streamMockResponse(model, payload);
  }

	const stream = new SimpleAssistantEventStream(model.provider, model.id);
	const url = `${baseUrl}/v1/omp/copilot/chat`;
	queueMicrotask(async () => {
		try {
			observe("transport.request", {
				url,
				headers: Object.fromEntries(buildHeaders(model, options).entries()),
			});
			const response = await fetch(url, {
				method: "POST",
				headers: buildHeaders(model, options),
				body: JSON.stringify(payload),
				signal: options.signal,
			});
			if (!response.ok) {
				const body = await response.text().catch(() => "");
				observe("transport.response_error", {
					status: response.status,
					statusText: response.statusText,
					body,
				});
				throw new Error(`Gateway request failed (${response.status}): ${body || response.statusText}`);
			}
			const contentType = response.headers.get("content-type") ?? "";
			observe("transport.response", {
				status: response.status,
				contentType,
			});
			if (contentType.includes("text/event-stream")) {
				await applySseResponse(stream, response);
				return;
			}
			const json = (await response.json()) as GatewayJsonResponse;
			applyJsonResponse(stream, json);
		} catch (error) {
			observe("transport.fail", {
				error: error instanceof Error ? error.message : String(error),
			});
			stream.fail("error", error instanceof Error ? error.message : String(error));
		}
	});
	return stream;
}