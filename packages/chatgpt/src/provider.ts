import {
    AuthError,
    ContentFilterError,
    ContextLengthError,
    ProviderError,
    RateLimitError,
    UnsupportedFeatureError,
    createLanguageModel,
    type AssistantContentPart,
    type Capabilities,
    type GenerateRequest,
    type Message,
    type Provider,
    type ProviderMetadata,
    type ProviderOptions,
    type StreamPart,
    type Tool,
    type ToolChoice,
    type Usage,
} from "@any-model/core";
import { ChatGPTAuthManager, type FetchFunction } from "./auth-manager.ts";
import type { ChatGPTCredentialStore } from "./credentials.ts";
import {
    CHATGPT_CODEX_BASE_URL,
    type ChatGPTResponseEvent,
    type ChatGPTResponsesRequest,
} from "./wire.ts";

const CHATGPT_ID = "chatgpt";

export interface ChatGPTConfig {
    credentialStore: ChatGPTCredentialStore;
    /** Defaults to the experimental ChatGPT Codex backend base URL. */
    baseURL?: string;
    headers?: Record<string, string>;
    capabilities?: Partial<Capabilities>;
    fetch?: FetchFunction;
}

export interface ChatGPTOptions {
    /** Native Responses reasoning configuration. */
    reasoning?: Record<string, unknown>;
    /** Native response fields to include, such as encrypted reasoning content. */
    include?: string[];
    [key: string]: unknown;
}

const DEFAULT_CAPABILITIES: Capabilities = {
    streaming: true,
    tools: true,
    vision: true,
    jsonSchema: false,
    reasoning: true,
    promptCaching: false,
};

export function chatGPT(config: ChatGPTConfig): Provider {
    if (!config?.credentialStore) throw new TypeError("ChatGPT credentialStore is required.");
    const fetchImpl = config.fetch ?? globalThis.fetch;
    const auth = new ChatGPTAuthManager(config.credentialStore, fetchImpl);
    const endpoint = `${(config.baseURL ?? CHATGPT_CODEX_BASE_URL).replace(/\/+$/, "")}/responses`;
    const capabilities = { ...DEFAULT_CAPABILITIES, ...config.capabilities };

    return {
        id: CHATGPT_ID,
        languageModel(modelId) {
            return createLanguageModel({
                provider: CHATGPT_ID,
                modelId,
                capabilities,
                doStream: (request) =>
                    streamResponse({ config, endpoint, fetchImpl, auth, modelId, request }),
            });
        },
    };
}

export function chatGPTOptions(options: ChatGPTOptions): ProviderOptions {
    return { chatgpt: options };
}

async function* streamResponse(input: {
    config: ChatGPTConfig;
    endpoint: string;
    fetchImpl: FetchFunction;
    auth: ChatGPTAuthManager;
    modelId: string;
    request: GenerateRequest;
}): AsyncIterable<StreamPart> {
    const body = makeRequestBody(input.modelId, input.request);
    let credentials = await input.auth.getCredentials();
    let response = await sendRequest(input, body, credentials);
    if (response.status === 401) {
        await response.body?.cancel();
        credentials = await input.auth.refreshAfterUnauthorized(credentials.accessToken);
        response = await sendRequest(input, body, credentials);
        if (response.status === 401) {
            await response.body?.cancel();
            await input.auth.clear();
            throw new AuthError("ChatGPT rejected refreshed credentials. Sign in again.", {
                provider: CHATGPT_ID,
                statusCode: 401,
            });
        }
    }
    if (!response.ok) throw await errorFromResponse(response);
    if (!response.body) {
        throw new ProviderError("ChatGPT response had no body.", {
            provider: CHATGPT_ID,
            statusCode: response.status,
        });
    }
    yield* normalizeEvents(parseSSE(response.body));
}

async function sendRequest(
    input: {
        config: ChatGPTConfig;
        endpoint: string;
        fetchImpl: FetchFunction;
        request: GenerateRequest;
    },
    body: ChatGPTResponsesRequest,
    credentials: { accessToken: string; accountId: string },
): Promise<Response> {
    const headers = withoutProtectedHeaders({
        ...input.config.headers,
        ...input.request.headers,
    });
    headers["content-type"] = "application/json";
    headers.accept = "text/event-stream";
    headers.authorization = `Bearer ${credentials.accessToken}`;
    headers["chatgpt-account-id"] = credentials.accountId;
    try {
        return await input.fetchImpl(input.endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: input.request.abortSignal,
        });
    } catch (cause) {
        if (input.request.abortSignal?.aborted || isAbortError(cause)) throw cause;
        throw new ProviderError("ChatGPT Responses request failed.", {
            provider: CHATGPT_ID,
            cause,
            isRetryable: true,
        });
    }
}

/** Per-tool strict override wins; falls back to the request-level default; else omitted. */
function strictFor(tool: Tool, request: GenerateRequest): boolean | undefined {
    const perTool = tool.providerOptions?.[CHATGPT_ID]?.strict;
    if (typeof perTool === "boolean") return perTool;
    const perRequest = request.providerOptions?.[CHATGPT_ID]?.strict;
    return typeof perRequest === "boolean" ? perRequest : undefined;
}

export function makeRequestBody(
    modelId: string,
    request: GenerateRequest,
): ChatGPTResponsesRequest {
    assertSupportedSettings(request);
    const options = request.providerOptions?.chatgpt ?? {};
    const extra = withoutProtectedFields(options);
    const body: ChatGPTResponsesRequest = {
        ...extra,
        model: modelId,
        input: toResponseInput(request.messages),
        stream: true,
        store: false,
    };
    const instructions = request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
    if (instructions) body.instructions = instructions;
    if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
    if (request.tools) {
        body.tools = request.tools.map((tool) => {
            const strict = strictFor(tool, request);
            return {
                type: "function",
                name: tool.name,
                ...(tool.description === undefined ? {} : { description: tool.description }),
                parameters: tool.inputSchema,
                ...(strict === undefined ? {} : { strict }),
            };
        });
    }
    if (request.toolChoice !== undefined) body.tool_choice = toToolChoice(request.toolChoice);
    const include = Array.isArray(options.include) ? [...options.include] : [];
    if (!include.includes("reasoning.encrypted_content")) {
        include.push("reasoning.encrypted_content");
    }
    body.include = include;
    return body;
}

function assertSupportedSettings(request: GenerateRequest): void {
    if (request.temperature !== undefined) {
        throw new UnsupportedFeatureError("temperature", { provider: CHATGPT_ID });
    }
    if (request.topP !== undefined) {
        throw new UnsupportedFeatureError("topP", { provider: CHATGPT_ID });
    }
    if (request.stopSequences !== undefined) {
        throw new UnsupportedFeatureError("stopSequences", { provider: CHATGPT_ID });
    }
    if (request.responseFormat !== undefined) {
        throw new UnsupportedFeatureError("responseFormat", { provider: CHATGPT_ID });
    }
}

function toResponseInput(messages: Message[]): unknown[] {
    const input: unknown[] = [];
    for (const message of messages) {
        if (message.role === "system") continue;
        if (message.role === "tool") {
            for (const part of message.content) {
                input.push({
                    type: "function_call_output",
                    call_id: part.toolCallId,
                    output: stringify(part.result),
                });
            }
            continue;
        }
        if (message.role === "user") {
            const content =
                typeof message.content === "string"
                    ? [{ type: "input_text", text: message.content }]
                    : message.content.map(toUserContent);
            input.push({ type: "message", role: "user", content });
            continue;
        }
        if (typeof message.content === "string") {
            input.push({
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: message.content }],
            });
        } else {
            input.push(...toAssistantInput(message.content));
        }
    }
    return input;
}

function toUserContent(
    part: Extract<Message, { role: "user" }> extends { content: infer C }
        ? C extends Array<infer P>
            ? P
            : never
        : never,
): unknown {
    if (part.type === "text") return { type: "input_text", text: part.text };
    if (part.type === "file") {
        throw new UnsupportedFeatureError("file input", { provider: CHATGPT_ID });
    }
    return { type: "input_image", image_url: imageURL(part.image, part.mediaType) };
}

function toAssistantInput(parts: AssistantContentPart[]): unknown[] {
    const items: unknown[] = [];
    let text: unknown[] = [];
    const flushText = () => {
        if (text.length) items.push({ type: "message", role: "assistant", content: text });
        text = [];
    };
    for (const part of parts) {
        if (part.type === "text") {
            text.push({ type: "output_text", text: part.text });
            continue;
        }
        flushText();
        if (part.type === "reasoning") {
            const metadata = part.providerMetadata?.chatgpt;
            items.push({
                type: "reasoning",
                ...(typeof metadata?.itemId === "string" ? { id: metadata.itemId } : {}),
                ...(typeof metadata?.encryptedContent === "string"
                    ? { encrypted_content: metadata.encryptedContent }
                    : {}),
                summary: part.text ? [{ type: "summary_text", text: part.text }] : [],
            });
        } else {
            items.push({
                type: "function_call",
                call_id: part.toolCallId,
                name: part.toolName,
                arguments: JSON.stringify(part.args),
            });
        }
    }
    flushText();
    return items;
}

function imageURL(image: string | URL | Uint8Array, mediaType?: string): string {
    if (image instanceof URL) return image.toString();
    if (image instanceof Uint8Array) {
        if (!mediaType?.startsWith("image/")) {
            throw new UnsupportedFeatureError("binary image without image mediaType", {
                provider: CHATGPT_ID,
            });
        }
        let binary = "";
        for (const byte of image) binary += String.fromCharCode(byte);
        return `data:${mediaType};base64,${btoa(binary)}`;
    }
    if (/^(https?:|data:)/i.test(image)) return image;
    if (!mediaType?.startsWith("image/")) {
        throw new UnsupportedFeatureError("base64 image without image mediaType", {
            provider: CHATGPT_ID,
        });
    }
    return `data:${mediaType};base64,${image}`;
}

function toToolChoice(choice: ToolChoice): unknown {
    if (typeof choice === "string") return choice;
    return { type: "function", name: choice.toolName };
}

async function* parseSSE(
    body: ReadableStream<Uint8Array>,
): AsyncIterable<ChatGPTResponseEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];

    const parseEvent = (): ChatGPTResponseEvent | "done" | undefined => {
        if (!dataLines.length) return undefined;
        const data = dataLines.join("\n");
        dataLines = [];
        if (data.trim() === "[DONE]") return "done";
        try {
            return JSON.parse(data) as ChatGPTResponseEvent;
        } catch (cause) {
            throw new ProviderError("Malformed JSON in ChatGPT Responses SSE event.", {
                provider: CHATGPT_ID,
                cause,
                raw: data,
            });
        }
    };

    while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = done ? "" : (lines.pop() ?? "");
        for (const line of lines) {
            if (line === "") {
                const event = parseEvent();
                if (event === "done") return;
                if (event) yield event;
            } else if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).replace(/^ /, ""));
            }
        }
        if (done) break;
    }
    if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).replace(/^ /, ""));
    const event = parseEvent();
    if (event && event !== "done") yield event;
}

interface PendingReasoning {
    text: string;
    itemId?: string;
}

interface PendingTool {
    callId: string;
    name: string;
    ended: boolean;
}

async function* normalizeEvents(
    events: AsyncIterable<ChatGPTResponseEvent>,
): AsyncIterable<StreamPart> {
    const reasoning = new Map<string, PendingReasoning>();
    const tools = new Map<string, PendingTool>();
    const toolAliases = new Map<string, string>();

    const reasoningKey = (event: ChatGPTResponseEvent) =>
        event.item_id ?? `output:${event.output_index ?? 0}`;

    const flushReasoning = function* (
        key: string,
        item?: Record<string, unknown>,
    ): Iterable<StreamPart> {
        const pending = reasoning.get(key);
        if (!pending) return;
        reasoning.delete(key);
        const itemId = stringValue(item?.id) ?? pending.itemId;
        const encryptedContent = stringValue(item?.encrypted_content);
        const metadata = chatGPTMetadata({ itemId, encryptedContent });
        if (pending.text || metadata) {
            yield {
                type: "reasoning-delta",
                text: pending.text,
                ...(metadata === undefined ? {} : { providerMetadata: metadata }),
            };
        }
    };

    for await (const event of events) {
        yield { type: "raw", value: event };
        switch (event.type) {
            case "response.output_text.delta": {
                if (typeof event.delta === "string") {
                    const metadata = chatGPTMetadata({ itemId: event.item_id });
                    yield {
                        type: "text-delta",
                        text: event.delta,
                        ...(metadata === undefined ? {} : { providerMetadata: metadata }),
                    };
                }
                break;
            }
            case "response.reasoning_summary_text.delta": {
                const key = reasoningKey(event);
                const pending = reasoning.get(key) ?? { text: "", itemId: event.item_id };
                if (typeof event.delta === "string") pending.text += event.delta;
                reasoning.set(key, pending);
                break;
            }
            case "response.output_item.added": {
                const item = event.item;
                if (item?.type === "function_call") {
                    const callId = stringValue(item.call_id) ?? event.call_id ?? stringValue(item.id);
                    const name = stringValue(item.name) ?? event.name;
                    if (callId && name && !tools.has(callId)) {
                        tools.set(callId, { callId, name, ended: false });
                        if (typeof item.id === "string") toolAliases.set(item.id, callId);
                        yield {
                            type: "tool-call-start",
                            toolCallId: callId,
                            toolName: name,
                            providerMetadata: {
                                chatgpt: { ...(typeof item.id === "string" ? { itemId: item.id } : {}) },
                            },
                        };
                    }
                }
                break;
            }
            case "response.function_call_arguments.delta": {
                const eventId = event.call_id ?? event.item_id;
                const callId = eventId === undefined ? undefined : (toolAliases.get(eventId) ?? eventId);
                if (callId && typeof event.delta === "string") {
                    yield { type: "tool-call-delta", toolCallId: callId, argsDelta: event.delta };
                }
                break;
            }
            case "response.function_call_arguments.done": {
                const eventId = event.call_id ?? event.item_id;
                const callId = eventId === undefined ? undefined : (toolAliases.get(eventId) ?? eventId);
                const tool = callId ? tools.get(callId) : undefined;
                if (tool && !tool.ended) {
                    tool.ended = true;
                    yield {
                        type: "tool-call-end",
                        toolCallId: tool.callId,
                        ...(typeof event.arguments === "string"
                            ? { args: safeParseArguments(event.arguments) }
                            : {}),
                    };
                }
                break;
            }
            case "response.output_item.done": {
                const item = event.item;
                const key = event.item_id ?? stringValue(item?.id) ?? reasoningKey(event);
                if (item?.type === "reasoning" || reasoning.has(key)) {
                    yield* flushReasoning(key, item);
                }
                if (item?.type === "function_call") {
                    const callId = stringValue(item.call_id) ?? event.call_id ?? stringValue(item.id);
                    const tool = callId ? tools.get(callId) : undefined;
                    if (tool && !tool.ended) {
                        tool.ended = true;
                        const argsText = stringValue(item.arguments);
                        yield {
                            type: "tool-call-end",
                            toolCallId: tool.callId,
                            ...(argsText === undefined ? {} : { args: safeParseArguments(argsText) }),
                            providerMetadata: {
                                chatgpt: { ...(typeof item.id === "string" ? { itemId: item.id } : {}) },
                            },
                        };
                    }
                }
                break;
            }
            case "response.completed":
            case "response.incomplete": {
                for (const key of [...reasoning.keys()]) yield* flushReasoning(key);
                for (const tool of tools.values()) {
                    if (!tool.ended) {
                        tool.ended = true;
                        yield { type: "tool-call-end", toolCallId: tool.callId };
                    }
                }
                const response = event.response ?? {};
                const incompleteReason = recordValue(response.incomplete_details)?.reason;
                const finishReason =
                    event.type === "response.incomplete"
                        ? incompleteReason === "content_filter"
                            ? "content-filter"
                            : "length"
                        : tools.size
                          ? "tool-calls"
                          : "stop";
                yield {
                    type: "finish",
                    finishReason,
                    usage: mapUsage(recordValue(response.usage)),
                    providerMetadata: {
                        chatgpt: {
                            ...(typeof response.id === "string" ? { responseId: response.id } : {}),
                        },
                    },
                };
                break;
            }
            case "response.failed": {
                const response = event.response ?? {};
                yield {
                    type: "error",
                    error: errorFromPayload(recordValue(response.error) ?? event.error ?? {}),
                };
                return;
            }
            case "error": {
                yield { type: "error", error: errorFromPayload(event.error ?? event) };
                return;
            }
        }
    }
}

function mapUsage(usage: Record<string, unknown> | undefined): Usage {
    if (!usage) return {};
    const inputDetails = recordValue(usage.input_tokens_details);
    const outputDetails = recordValue(usage.output_tokens_details);
    return {
        ...(numberValue(usage.input_tokens) === undefined
            ? {}
            : { inputTokens: numberValue(usage.input_tokens) }),
        ...(numberValue(usage.output_tokens) === undefined
            ? {}
            : { outputTokens: numberValue(usage.output_tokens) }),
        ...(numberValue(usage.total_tokens) === undefined
            ? {}
            : { totalTokens: numberValue(usage.total_tokens) }),
        ...(numberValue(outputDetails?.reasoning_tokens) === undefined
            ? {}
            : { reasoningTokens: numberValue(outputDetails?.reasoning_tokens) }),
        ...(numberValue(inputDetails?.cached_tokens) === undefined
            ? {}
            : { cachedInputTokens: numberValue(inputDetails?.cached_tokens) }),
    };
}

async function errorFromResponse(response: Response): Promise<Error> {
    let payload: Record<string, unknown> = {};
    try {
        const value: unknown = await response.json();
        if (typeof value === "object" && value !== null) payload = value as Record<string, unknown>;
    } catch {
        // Do not include arbitrary response bodies in errors: OAuth gateways can
        // echo credential-like material.
    }
    const nested = recordValue(payload.error) ?? payload;
    const message = stringValue(nested.message) ?? `ChatGPT request failed (${response.status}).`;
    if (response.status === 401 || response.status === 403) {
        return new AuthError(message, { provider: CHATGPT_ID, statusCode: response.status });
    }
    if (response.status === 429) {
        return new RateLimitError(message, {
            provider: CHATGPT_ID,
            statusCode: response.status,
            retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
        });
    }
    const code = stringValue(nested.code) ?? stringValue(nested.type);
    if (code?.includes("context_length") || code?.includes("max_tokens")) {
        return new ContextLengthError(message, {
            provider: CHATGPT_ID,
            statusCode: response.status,
        });
    }
    if (code?.includes("content_filter") || code?.includes("safety")) {
        return new ContentFilterError(message, {
            provider: CHATGPT_ID,
            statusCode: response.status,
        });
    }
    return new ProviderError(message, {
        provider: CHATGPT_ID,
        statusCode: response.status,
    });
}

function errorFromPayload(payload: Record<string, unknown>): Error {
    return new ProviderError(stringValue(payload.message) ?? "ChatGPT response failed.", {
        provider: CHATGPT_ID,
        isRetryable: stringValue(payload.type) === "server_error",
    });
}

function withoutProtectedFields(value: Record<string, unknown>): Record<string, unknown> {
    const result = { ...value };
    for (const key of [
        "model",
        "input",
        "stream",
        "store",
        "instructions",
        "tools",
        "tool_choice",
        "max_output_tokens",
        "include",
    ]) {
        delete result[key];
    }
    return result;
}

function withoutProtectedHeaders(headers: Record<string, string>): Record<string, string> {
    const protectedNames = new Set([
        "authorization",
        "chatgpt-account-id",
        "content-type",
        "accept",
    ]);
    return Object.fromEntries(
        Object.entries(headers).filter(([name]) => !protectedNames.has(name.toLowerCase())),
    );
}

function chatGPTMetadata(input: {
    itemId?: string;
    encryptedContent?: string;
}): ProviderMetadata | undefined {
    if (!input.itemId && !input.encryptedContent) return undefined;
    return {
        chatgpt: {
            ...(input.itemId ? { itemId: input.itemId } : {}),
            ...(input.encryptedContent ? { encryptedContent: input.encryptedContent } : {}),
        },
    };
}

function safeParseArguments(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return { __unparsed: value };
    }
}

function stringify(value: unknown): string {
    return typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
}

function stringValue(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function retryAfterMs(value: string | null): number | undefined {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const date = Date.parse(value);
    return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}
