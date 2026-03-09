export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export type TextPart = { type: "text"; text: string };
export type ToolCallPart = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
export type AssistantPart = TextPart | ToolCallPart;

export type AssistantMessageLike = {
  role: "assistant";
  content: AssistantPart[];
  provider: string;
  model: string;
  api?: string;
  providerPayload?: unknown;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: StopReason;
  timestamp: number;
  duration?: number;
  ttft?: number;
  errorMessage?: string;
};

export type AssistantEventLike =
  | { type: "start"; partial: AssistantMessageLike }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessageLike }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessageLike }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessageLike }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessageLike }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessageLike }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallPart; partial: AssistantMessageLike }
  | { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessageLike }
  | { type: "error"; reason: Extract<StopReason, "error" | "aborted">; error: AssistantMessageLike };

function cloneMessage(message: AssistantMessageLike): AssistantMessageLike {
  return {
    ...message,
    usage: { ...message.usage, cost: { ...message.usage.cost } },
    content: message.content.map(part => (part.type === "text" ? { ...part } : { ...part, arguments: { ...part.arguments } })),
  };
}

function createEmptyMessage(provider: string, model: string): AssistantMessageLike {
  return {
    role: "assistant",
    content: [],
    provider,
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export class SimpleAssistantEventStream implements AsyncIterable<AssistantEventLike>, AsyncIterator<AssistantEventLike> {
  #message: AssistantMessageLike;
  #queue: AssistantEventLike[] = [];
  #waiters: Array<(result: IteratorResult<AssistantEventLike>) => void> = [];
  #closed = false;
  #started = false;
  #activeTextIndex: number | null = null;
  #resultResolve!: (value: AssistantMessageLike) => void;
  #resultReject!: (reason?: unknown) => void;
  #resultPromise: Promise<AssistantMessageLike>;

  constructor(provider: string, model: string) {
    this.#message = createEmptyMessage(provider, model);
    this.#resultPromise = new Promise<AssistantMessageLike>((resolve, reject) => {
      this.#resultResolve = resolve;
      this.#resultReject = reject;
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<AssistantEventLike> {
    return this;
  }

  next(): Promise<IteratorResult<AssistantEventLike>> {
    if (this.#queue.length > 0) {
      return Promise.resolve({ done: false, value: this.#queue.shift()! });
    }
    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise(resolve => this.#waiters.push(resolve));
  }

  result(): Promise<AssistantMessageLike> {
    return this.#resultPromise;
  }

  mergeDelegateMetadata(message: Partial<AssistantMessageLike> & Record<string, unknown>): void {
    const { role, provider, model, content, usage, ...rest } = message;
    Object.assign(this.#message, structuredClone(rest));
    if (usage) {
      this.#message.usage = {
        ...this.#message.usage,
        ...structuredClone(usage),
        cost: {
          ...this.#message.usage.cost,
          ...(structuredClone(usage.cost) as AssistantMessageLike["usage"]["cost"] | undefined),
        },
      };
    }
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#push({ type: "start", partial: cloneMessage(this.#message) });
  }

  appendText(delta: string): void {
    if (!delta) return;
    this.start();
    if (this.#activeTextIndex === null) {
      this.#activeTextIndex = this.#message.content.length;
      this.#message.content.push({ type: "text", text: "" });
      this.#push({ type: "text_start", contentIndex: this.#activeTextIndex, partial: cloneMessage(this.#message) });
    }
    const part = this.#message.content[this.#activeTextIndex] as TextPart;
    part.text += delta;
    this.#push({
      type: "text_delta",
      contentIndex: this.#activeTextIndex,
      delta,
      partial: cloneMessage(this.#message),
    });
  }

  endText(): void {
    if (this.#activeTextIndex === null) return;
    const part = this.#message.content[this.#activeTextIndex] as TextPart;
    this.#push({
      type: "text_end",
      contentIndex: this.#activeTextIndex,
      content: part.text,
      partial: cloneMessage(this.#message),
    });
    this.#activeTextIndex = null;
  }

  addToolCall(name: string, argumentsObject: Record<string, unknown>, id = `tool_${Date.now()}`): void {
    this.endText();
    this.start();
    const contentIndex = this.#message.content.length;
    const toolCall: ToolCallPart = { type: "toolCall", id, name, arguments: argumentsObject };
    this.#message.content.push(toolCall);
    this.#push({ type: "toolcall_start", contentIndex, partial: cloneMessage(this.#message) });
    this.#push({
      type: "toolcall_delta",
      contentIndex,
      delta: JSON.stringify({ name, arguments: argumentsObject }),
      partial: cloneMessage(this.#message),
    });
    this.#push({ type: "toolcall_end", contentIndex, toolCall, partial: cloneMessage(this.#message) });
  }

  done(reason: Extract<StopReason, "stop" | "length" | "toolUse"> = "stop"): void {
    if (this.#closed) return;
    this.endText();
    this.#message.stopReason = reason;
    const finalMessage = cloneMessage(this.#message);
    this.#push({ type: "done", reason, message: finalMessage });
    this.#close(finalMessage);
  }

  fail(reason: Extract<StopReason, "error" | "aborted">, errorMessage: string): void {
    if (this.#closed) return;
    this.endText();
    this.#message.stopReason = reason;
    this.#message.errorMessage = errorMessage;
    const finalMessage = cloneMessage(this.#message);
    this.#push({ type: "error", reason, error: finalMessage });
    this.#close(finalMessage, new Error(errorMessage));
  }

  #push(event: AssistantEventLike): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value: event });
      return;
    }
    this.#queue.push(event);
  }

  #close(result: AssistantMessageLike, error?: Error): void {
    this.#closed = true;
    if (error) {
      this.#resultReject(error);
    } else {
      this.#resultResolve(result);
    }
    while (this.#waiters.length > 0) {
      this.#waiters.shift()!({ done: true, value: undefined });
    }
  }
}