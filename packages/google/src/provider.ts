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
    type ToolChoice,
    type Usage,
} from "@any-model/core";
import type {
    GoogleApiError,
    GoogleInteraction,
    GoogleInteractionEvent,
    GoogleInteractionRequest,
} from "./wire.ts";

const GOOGLE_ID = "google";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export type FetchFunction = (
    input: string | URL | Request,
    init?: RequestInit,
) => Promise<Response>;

export interface GoogleConfig {
    apiKey: string;
    baseURL?: string;
    headers?: Record<string, string>;
    capabilities?: Partial<Capabilities>;
    fetch?: FetchFunction;
}

export interface GoogleGenerationConfig {
    thinking_level?: string;
    thinking_summaries?: string;
    tool_choice?: unknown;
    [key: string]: unknown;
}

export interface GoogleOptions {
    previousInteractionId?: string;
    store?: boolean;
    generationConfig?: GoogleGenerationConfig;
    /** Native built-in tools such as `{ type: "google_search" }`. */
    tools?: Array<Record<string, unknown>>;
    [key: string]: unknown;
}

const DEFAULT_CAPABILITIES: Capabilities = {
    streaming: true,
    tools: true,
    vision: true,
    jsonSchema: true,
    reasoning: true,
    promptCaching: false,
};

export function google(config: GoogleConfig): Provider {
    if (!config?.apiKey) throw new TypeError("Google apiKey is required.");
    const endpoint = `${(config.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/interactions?alt=sse`;
    const fetchImpl = config.fetch ?? globalThis.fetch;
    const capabilities = { ...DEFAULT_CAPABILITIES, ...config.capabilities };

    return {
        id: GOOGLE_ID,
        languageModel(modelId) {
            return createLanguageModel({
                provider: GOOGLE_ID,
                modelId,
                capabilities,
                doStream: (request) =>
                    streamInteraction({ config, endpoint, fetchImpl, modelId, request }),
            });
        },
    };
}

export function googleOptions(options: GoogleOptions): ProviderOptions {
    return { google: options };
}

async function* streamInteraction(input: {
    config: GoogleConfig;
    endpoint: string;
    fetchImpl: FetchFunction;
    modelId: string;
    request: GenerateRequest;
}): AsyncIterable<StreamPart> {
    const body = makeRequestBody(input.modelId, input.request);
    const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "text/event-stream",
        "x-goog-api-key": input.config.apiKey,
        ...input.config.headers,
        ...input.request.headers,
    };

    let response: Response;
    try {
        response = await input.fetchImpl(input.endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: input.request.abortSignal,
        });
    } catch (error) {
        if (input.request.abortSignal?.aborted || isAbortError(error)) throw error;
        throw new ProviderError("Google Interactions request failed.", {
            provider: GOOGLE_ID,
            cause: error,
            isRetryable: true,
        });
    }

    if (!response.ok) throw await errorFromResponse(response);
    if (!response.body) {
        throw new ProviderError("Google Interactions response had no body.", {
            provider: GOOGLE_ID,
            statusCode: response.status,
        });
    }
    yield* normalizeEvents(parseSSE(response.body));
}

export function makeRequestBody(
    modelId: string,
    request: GenerateRequest,
): GoogleInteractionRequest {
    const options = (request.providerOptions?.google ?? {}) as GoogleOptions;
    const body: GoogleInteractionRequest = {
        ...withoutProtectedFields(options),
        model: modelId,
        input: toInteractionInput(request.messages),
        stream: true,
    };
    const system = request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
    if (system) body.system_instruction = system;
    if (options.previousInteractionId) body.previous_interaction_id = options.previousInteractionId;
    if (options.store !== undefined) body.store = options.store;

    const nativeTools = options.tools ?? [];
    const customTools = (request.tools ?? []).map((tool) => ({
        type: "function",
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        parameters: tool.inputSchema,
    }));
    if (nativeTools.length || customTools.length) body.tools = [...nativeTools, ...customTools];

    const generationConfig: Record<string, unknown> = { ...(options.generationConfig ?? {}) };
    delete generationConfig.tool_choice;
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (request.topP !== undefined) generationConfig.top_p = request.topP;
    if (request.maxOutputTokens !== undefined)
        generationConfig.max_output_tokens = request.maxOutputTokens;
    if (request.stopSequences !== undefined)
        generationConfig.stop_sequences = request.stopSequences;
    if (request.toolChoice !== undefined)
        generationConfig.tool_choice = toToolChoice(request.toolChoice);
    if (Object.keys(generationConfig).length) body.generation_config = generationConfig;

    if (request.responseFormat?.type === "json") {
        body.response_format = {
            type: "text",
            mime_type: "application/json",
            ...(request.responseFormat.schema === undefined
                ? {}
                : { schema: request.responseFormat.schema }),
        };
    } else if (request.responseFormat?.type === "text") {
        body.response_format = { type: "text", mime_type: "text/plain" };
    }
    return body;
}

function toInteractionInput(messages: Message[]): unknown[] {
    const input: unknown[] = [];
    for (const message of messages) {
        if (message.role === "system") continue;
        if (message.role === "tool") {
            for (const part of message.content) {
                input.push({
                    type: "function_result",
                    call_id: part.toolCallId,
                    name: part.toolName,
                    result: [{ type: "text", text: stringify(part.result) }],
                    ...(part.isError === undefined ? {} : { is_error: part.isError }),
                });
            }
            continue;
        }
        if (message.role === "user") {
            const content =
                typeof message.content === "string"
                    ? [{ type: "text", text: message.content }]
                    : message.content.map(toInputContent);
            input.push({ type: "user_input", content });
            continue;
        }
        if (typeof message.content === "string") {
            input.push({
                type: "model_output",
                content: [{ type: "text", text: message.content }],
            });
            continue;
        }
        input.push(...toAssistantSteps(message.content));
    }
    return input;
}

function toAssistantSteps(parts: AssistantContentPart[]): unknown[] {
    const steps: unknown[] = [];
    let modelContent: unknown[] = [];
    let thought: { text: string; signature?: string } | undefined;
    const flushModel = () => {
        if (modelContent.length) steps.push({ type: "model_output", content: modelContent });
        modelContent = [];
    };
    const flushThought = () => {
        if (!thought) return;
        steps.push({
            type: "thought",
            ...(thought.signature === undefined ? {} : { signature: thought.signature }),
            summary: thought.text ? [{ type: "text", text: thought.text }] : [],
        });
        thought = undefined;
    };
    for (const part of parts) {
        if (part.type === "text") {
            flushThought();
            modelContent.push({ type: "text", text: part.text });
        } else if (part.type === "reasoning") {
            flushModel();
            const google = part.providerMetadata?.google;
            const signature = typeof google?.signature === "string" ? google.signature : undefined;
            if (thought && thought.signature !== undefined && signature !== undefined)
                flushThought();
            thought ??= { text: "" };
            thought.text += part.text;
            if (signature !== undefined) thought.signature = signature;
        } else {
            flushModel();
            flushThought();
            steps.push({
                type: "function_call",
                id: part.toolCallId,
                name: part.toolName,
                arguments: part.args,
            });
        }
    }
    flushModel();
    flushThought();
    return steps;
}

function toInputContent(
    part: Extract<Message, { role: "user" }> extends { content: infer C }
        ? C extends Array<infer P>
            ? P
            : never
        : never,
): unknown {
    if (part.type === "text") return { type: "text", text: part.text };
    const value = part.type === "image" ? part.image : part.data;
    return mediaContent(
        value,
        part.mediaType,
        part.type === "image" ? "image" : mediaKind(part.mediaType),
    );
}

function mediaContent(
    value: string | URL | Uint8Array,
    mediaType: string | undefined,
    type: string,
): unknown {
    if (!mediaType)
        throw new UnsupportedFeatureError("media input without mediaType", { provider: GOOGLE_ID });
    if (value instanceof Uint8Array)
        return { type, mime_type: mediaType, data: bytesToBase64(value) };
    const text = value instanceof URL ? value.toString() : value;
    const data = parseDataURL(text);
    if (data) return { type, mime_type: data.mediaType, data: data.data };
    if (isAllowedFileURI(text)) return { type, mime_type: mediaType, uri: text };
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) {
        throw new UnsupportedFeatureError("arbitrary remote media URL", { provider: GOOGLE_ID });
    }
    return { type, mime_type: mediaType, data: text };
}

function mediaKind(mediaType: string): string {
    if (mediaType.startsWith("image/")) return "image";
    if (mediaType.startsWith("audio/")) return "audio";
    if (mediaType.startsWith("video/")) return "video";
    return "document";
}

function parseDataURL(value: string): { mediaType: string; data: string } | undefined {
    const match = /^data:([^;,]+);base64,(.*)$/is.exec(value);
    return match?.[1] && match[2] !== undefined
        ? { mediaType: match[1], data: match[2] }
        : undefined;
}

function isAllowedFileURI(value: string): boolean {
    if (value.startsWith("gs://")) return true;
    try {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname === "generativelanguage.googleapis.com";
    } catch {
        return false;
    }
}

function bytesToBase64(value: Uint8Array): string {
    let binary = "";
    for (const byte of value) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function toToolChoice(choice: ToolChoice): unknown {
    if (choice === "auto") return { allowed_tools: { mode: "auto" } };
    if (choice === "none") return { allowed_tools: { mode: "none" } };
    if (choice === "required") return { allowed_tools: { mode: "any" } };
    return { allowed_tools: { mode: "any", tools: [choice.toolName] } };
}

async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncIterable<GoogleInteractionEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];

    const parseEvent = (): GoogleInteractionEvent | undefined => {
        if (!dataLines.length) return undefined;
        const data = dataLines.join("\n");
        dataLines = [];
        try {
            return JSON.parse(data) as GoogleInteractionEvent;
        } catch (cause) {
            throw new ProviderError("Malformed JSON in Google Interactions SSE event.", {
                provider: GOOGLE_ID,
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
                if (event) yield event;
            } else if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).replace(/^ /, ""));
            }
        }
        if (done) break;
    }
    if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).replace(/^ /, ""));
    const event = parseEvent();
    if (event) yield event;
}

interface PendingCall {
    id: string;
    name: string;
    args: string;
    started: boolean;
}

async function* normalizeEvents(
    events: AsyncIterable<GoogleInteractionEvent>,
): AsyncIterable<StreamPart> {
    const calls = new Map<number, PendingCall>();
    const emittedSignatures = new Set<string>();
    let hadToolCall = false;
    for await (const event of events) {
        yield { type: "raw", value: event };
        if (event.error) {
            yield { type: "error", error: errorFromApi(event.error) };
            return;
        }
        const eventType = event.event_type ?? event.type ?? "";
        const index = event.index ?? 0;
        if (eventType === "step.start") {
            const step = event.step ?? {};
            if (step.type === "function_call") {
                const call = {
                    id: typeof step.id === "string" ? step.id : `google-call-${index}`,
                    name: typeof step.name === "string" ? step.name : "",
                    args: "",
                    started: true,
                };
                calls.set(index, call);
                hadToolCall = true;
                yield { type: "tool-call-start", toolCallId: call.id, toolName: call.name };
                if (step.arguments !== undefined) {
                    const args =
                        typeof step.arguments === "string"
                            ? step.arguments
                            : JSON.stringify(step.arguments);
                    call.args += args;
                    yield { type: "tool-call-delta", toolCallId: call.id, argsDelta: args };
                }
            }
        } else if (eventType === "step.delta") {
            const delta = event.delta ?? {};
            if (delta.type === "text" && typeof delta.text === "string") {
                yield { type: "text-delta", text: delta.text };
            } else if (delta.type === "thought" && typeof delta.text === "string") {
                yield { type: "reasoning-delta", text: delta.text };
            } else if (delta.type === "arguments") {
                const call = calls.get(index);
                const partial =
                    typeof delta.partial_arguments === "string"
                        ? delta.partial_arguments
                        : typeof delta.arguments === "string"
                          ? delta.arguments
                          : "";
                if (call && partial) {
                    call.args += partial;
                    yield { type: "tool-call-delta", toolCallId: call.id, argsDelta: partial };
                }
            }
        } else if (eventType === "step.stop") {
            const call = calls.get(index);
            if (call?.started) {
                yield { type: "tool-call-end", toolCallId: call.id };
                call.started = false;
            }
            const signature =
                typeof event.step?.signature === "string" ? event.step.signature : undefined;
            if (signature) {
                emittedSignatures.add(signature);
                yield signaturePart(signature);
            }
        } else if (eventType === "interaction.failed") {
            yield { type: "error", error: errorFromInteraction(event.interaction) };
            return;
        } else if (eventType === "interaction.completed" || eventType === "interaction.complete") {
            for (const step of event.interaction?.steps ?? []) {
                if (step.type === "thought" && typeof step.signature === "string") {
                    const signature = step.signature;
                    if (!emittedSignatures.has(signature)) {
                        emittedSignatures.add(signature);
                        yield signaturePart(signature);
                    }
                }
            }
            const interaction = event.interaction ?? {};
            const status = interaction.status ?? "completed";
            yield {
                type: "finish",
                finishReason: finishReason(status, hadToolCall),
                usage: mapUsage(interaction),
                providerMetadata: interactionMetadata(interaction),
            };
            return;
        }
    }
    yield { type: "finish", finishReason: hadToolCall ? "tool-calls" : "other", usage: {} };
}

function signaturePart(signature: string): StreamPart {
    return {
        type: "reasoning-delta",
        text: "",
        providerMetadata: { google: { signature } },
    };
}

function interactionMetadata(interaction: GoogleInteraction): ProviderMetadata {
    return {
        google: {
            ...(interaction.id === undefined ? {} : { interactionId: interaction.id }),
            ...(interaction.status === undefined ? {} : { status: interaction.status }),
        },
    };
}

function mapUsage(interaction: GoogleInteraction): Usage {
    const usage = interaction.usage;
    return {
        inputTokens: usage?.total_input_tokens,
        outputTokens: usage?.total_output_tokens,
        totalTokens: usage?.total_tokens,
        reasoningTokens: usage?.total_thought_tokens,
        cachedInputTokens: usage?.total_cached_tokens,
    };
}

function finishReason(
    status: string,
    hadToolCall: boolean,
): "stop" | "length" | "tool-calls" | "error" | "other" {
    if (status === "requires_action" || hadToolCall) return "tool-calls";
    if (status === "completed") return "stop";
    if (status === "incomplete") return "length";
    if (status === "failed" || status === "cancelled") return "error";
    return "other";
}

function withoutProtectedFields(options: GoogleOptions): Record<string, unknown> {
    const {
        previousInteractionId: _previousInteractionId,
        store: _store,
        generationConfig: _generationConfig,
        tools: _tools,
        ...extra
    } = options;
    const protectedFields = new Set([
        "model",
        "input",
        "stream",
        "system_instruction",
        "tools",
        "generation_config",
        "response_format",
        "previous_interaction_id",
        "store",
    ]);
    return Object.fromEntries(Object.entries(extra).filter(([key]) => !protectedFields.has(key)));
}

async function errorFromResponse(response: Response): Promise<Error> {
    const text = await response.text();
    let raw: unknown = text;
    let error: GoogleApiError = { code: response.status, message: text };
    try {
        raw = JSON.parse(text);
        error = (raw as { error?: GoogleApiError }).error ?? error;
    } catch {}
    return classifyError(error.message || `Google request failed with status ${response.status}.`, {
        code: response.status,
        status: error.status,
        raw,
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
    });
}

function errorFromApi(error: GoogleApiError): Error {
    return classifyError(error.message ?? "Google Interactions stream failed.", {
        code: error.code,
        status: error.status,
        raw: error,
    });
}

function errorFromInteraction(interaction: GoogleInteraction | undefined): Error {
    return errorFromApi(interaction?.error ?? { message: "Google interaction failed." });
}

function classifyError(
    message: string,
    input: {
        code?: number;
        status?: string;
        raw: unknown;
        retryAfterMs?: number;
    },
): Error {
    const status = input.status?.toLowerCase() ?? "";
    const options = { provider: GOOGLE_ID, statusCode: input.code, raw: input.raw };
    if (
        input.code === 401 ||
        input.code === 403 ||
        status === "unauthenticated" ||
        status === "permission_denied"
    ) {
        return new AuthError(message, options);
    }
    if (input.code === 429 || status === "resource_exhausted") {
        return new RateLimitError(message, { ...options, retryAfterMs: input.retryAfterMs });
    }
    if (/context|token limit|too many tokens/i.test(message))
        return new ContextLengthError(message, options);
    if (/safety|blocked|prohibited|content filter/i.test(message))
        return new ContentFilterError(message, options);
    return new ProviderError(message, options);
}

function parseRetryAfter(value: string | null): number | undefined {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function stringify(value: unknown): string {
    return typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}
