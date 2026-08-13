import {
    AuthError,
    ContentFilterError,
    ContextLengthError,
    ProviderError,
    RateLimitError,
    UnsupportedFeatureError,
    createLanguageModel,
    type Capabilities,
    type GenerateRequest,
    type Message,
    type Provider,
    type StreamPart,
    type ToolChoice,
    type Usage,
} from "@any-model/core";
import type {
    OpenAIChatCompletionChunk,
    OpenAIChatCompletionRequest,
    OpenAIToolCallDelta,
} from "./wire.ts";

export interface OpenAICompatibleConfig {
    id: string;
    baseURL: string;
    apiKey?: string;
    headers?: Record<string, string>;
    capabilities?: Partial<Capabilities>;
    fetch?: FetchFunction;
}

export type FetchFunction = (
    input: string | URL | Request,
    init?: RequestInit,
) => Promise<Response>;

const DEFAULT_CAPABILITIES: Capabilities = {
    streaming: true,
    tools: true,
    vision: true,
    jsonSchema: true,
    reasoning: false,
    promptCaching: false,
};

export function openAICompatible(config: OpenAICompatibleConfig): Provider {
    if (!config.id) throw new TypeError("OpenAI-compatible provider id is required.");
    if (!config.baseURL) throw new TypeError("OpenAI-compatible baseURL is required.");
    const endpoint = `${config.baseURL.replace(/\/+$/, "")}/chat/completions`;
    const fetchImpl = config.fetch ?? globalThis.fetch;
    const capabilities = { ...DEFAULT_CAPABILITIES, ...config.capabilities };

    return {
        id: config.id,
        languageModel(modelId) {
            return createLanguageModel({
                provider: config.id,
                modelId,
                capabilities,
                doStream: (request) =>
                    streamCompletion({
                        config,
                        endpoint,
                        fetchImpl,
                        modelId,
                        request,
                    }),
            });
        },
    };
}

async function* streamCompletion(input: {
    config: OpenAICompatibleConfig;
    endpoint: string;
    fetchImpl: FetchFunction;
    modelId: string;
    request: GenerateRequest;
}): AsyncIterable<StreamPart> {
    const body = makeRequestBody(input.config.id, input.modelId, input.request);
    const headers: Record<string, string> = {
        "content-type": "application/json",
        ...input.config.headers,
        ...input.request.headers,
    };
    if (input.config.apiKey && !hasHeader(headers, "authorization")) {
        headers.authorization = `Bearer ${input.config.apiKey}`;
    }

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
        throw new ProviderError("OpenAI-compatible request failed.", {
            provider: input.config.id,
            cause: error,
            isRetryable: true,
        });
    }

    if (!response.ok) throw await errorFromResponse(response, input.config.id);
    if (!response.body) {
        throw new ProviderError("OpenAI-compatible response had no body.", {
            provider: input.config.id,
            statusCode: response.status,
        });
    }

    yield* normalizeChunks(parseSSE(response.body, input.config.id), input.config.id);
}

export function makeRequestBody(
    providerId: string,
    modelId: string,
    request: GenerateRequest,
): OpenAIChatCompletionRequest {
    const extra = withoutProtectedFields(request.providerOptions?.[providerId] ?? {});
    const body: OpenAIChatCompletionRequest = {
        ...extra,
        model: modelId,
        messages: request.messages.flatMap((message) => toOpenAIMessage(message, providerId)),
        stream: true,
        stream_options: { include_usage: true },
    };
    if (request.tools) {
        body.tools = request.tools.map((tool) => ({
            type: "function",
            function: {
                name: tool.name,
                ...(tool.description === undefined ? {} : { description: tool.description }),
                parameters: tool.inputSchema,
            },
        }));
    }
    if (request.toolChoice !== undefined) body.tool_choice = toToolChoice(request.toolChoice);
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
    if (request.stopSequences !== undefined) body.stop = request.stopSequences;
    if (request.responseFormat?.type === "json") {
        body.response_format = request.responseFormat.schema
            ? {
                  type: "json_schema",
                  json_schema: {
                      name: request.responseFormat.name ?? "response",
                      schema: request.responseFormat.schema,
                      strict: true,
                  },
              }
            : { type: "json_object" };
    } else if (request.responseFormat?.type === "text") {
        body.response_format = { type: "text" };
    }
    return body;
}

function toOpenAIMessage(message: Message, provider: string): unknown[] {
    if (message.role === "system") return [{ role: "system", content: message.content }];
    if (message.role === "tool") {
        return message.content.map((part) => ({
            role: "tool",
            tool_call_id: part.toolCallId,
            content: stringifyContent(part.result),
        }));
    }
    if (typeof message.content === "string") {
        return [{ role: message.role, content: message.content }];
    }
    if (message.role === "user") {
        return [
            {
                role: "user",
                content: message.content.map((part) => {
                    if (part.type === "text") return { type: "text", text: part.text };
                    if (part.type === "file") {
                        throw new UnsupportedFeatureError("file input", { provider });
                    }
                    return {
                        type: "image_url",
                        image_url: { url: imageURL(part.image, part.mediaType, provider) },
                    };
                }),
            },
        ];
    }

    const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
    const toolCalls = message.content
        .filter((part) => part.type === "tool-call")
        .map((part) => ({
            id: part.toolCallId,
            type: "function",
            function: { name: part.toolName, arguments: JSON.stringify(part.args) },
        }));
    return [
        {
            role: "assistant",
            content: text || null,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
    ];
}

function imageURL(
    image: string | URL | Uint8Array,
    mediaType: string | undefined,
    provider: string,
): string {
    if (image instanceof URL) return image.toString();
    if (image instanceof Uint8Array) {
        if (!mediaType?.startsWith("image/")) {
            throw new UnsupportedFeatureError("binary image without image mediaType", {
                provider,
            });
        }
        let binary = "";
        for (const byte of image) binary += String.fromCharCode(byte);
        return `data:${mediaType};base64,${btoa(binary)}`;
    }
    if (/^(https?:|data:)/i.test(image)) return image;
    if (!mediaType?.startsWith("image/")) {
        throw new UnsupportedFeatureError("base64 image without image mediaType", {
            provider,
        });
    }
    return `data:${mediaType};base64,${image}`;
}

function toToolChoice(choice: ToolChoice): unknown {
    if (typeof choice === "string") return choice;
    return { type: "function", function: { name: choice.toolName } };
}

function stringifyContent(value: unknown): string {
    return typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
}

async function* parseSSE(
    body: ReadableStream<Uint8Array>,
    provider: string,
): AsyncIterable<OpenAIChatCompletionChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];

    const parseEvent = (): OpenAIChatCompletionChunk | "done" | undefined => {
        if (!dataLines.length) return undefined;
        const data = dataLines.join("\n");
        dataLines = [];
        if (data.trim() === "[DONE]") return "done";
        try {
            return JSON.parse(data) as OpenAIChatCompletionChunk;
        } catch (cause) {
            throw new ProviderError("Malformed JSON in OpenAI-compatible SSE event.", {
                provider,
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
    if (buffer) {
        if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).replace(/^ /, ""));
    }
    const event = parseEvent();
    if (event && event !== "done") yield event;
}

interface PendingTool {
    id: string;
    name: string;
    started: boolean;
    pendingArgs: string;
}

async function* normalizeChunks(
    chunks: AsyncIterable<OpenAIChatCompletionChunk>,
    provider: string,
): AsyncIterable<StreamPart> {
    const tools = new Map<number, PendingTool>();
    let finishReason: "stop" | "length" | "tool-calls" | "content-filter" | "error" | "other" =
        "other";
    let usage: Usage = {};

    for await (const chunk of chunks) {
        yield { type: "raw", value: chunk };
        if (chunk.error) {
            yield { type: "error", error: errorFromChunk(chunk.error, provider) };
            return;
        }
        if (chunk.usage) usage = mapUsage(chunk.usage);
        for (const choice of chunk.choices ?? []) {
            const delta = choice.delta;
            const reasoning = delta?.reasoning_content || delta?.reasoning;
            if (reasoning) yield { type: "reasoning-delta", text: reasoning };
            if (delta?.content) yield { type: "text-delta", text: delta.content };
            for (const toolDelta of delta?.tool_calls ?? []) {
                yield* normalizeToolDelta(tools, toolDelta);
            }
            if (choice.finish_reason) finishReason = mapFinishReason(choice.finish_reason);
        }
    }
    for (const tool of tools.values()) {
        if (tool.started) yield { type: "tool-call-end", toolCallId: tool.id };
    }
    yield { type: "finish", finishReason, usage };
}

function withoutProtectedFields(extra: Record<string, unknown>): Record<string, unknown> {
    const protectedFields = new Set([
        "model",
        "messages",
        "stream",
        "stream_options",
        "tools",
        "tool_choice",
        "temperature",
        "top_p",
        "max_tokens",
        "stop",
        "response_format",
    ]);
    return Object.fromEntries(Object.entries(extra).filter(([key]) => !protectedFields.has(key)));
}

function errorFromChunk(
    error: NonNullable<OpenAIChatCompletionChunk["error"]>,
    provider: string,
): Error {
    const numericCode = typeof error.code === "number" ? error.code : Number(error.code);
    const statusCode = Number.isFinite(numericCode) ? numericCode : undefined;
    const message = error.message ?? "OpenAI-compatible stream failed.";
    const errorType = error.metadata?.error_type?.toLowerCase() ?? "";
    const options = { provider, statusCode, raw: error };

    if (
        statusCode === 401 ||
        statusCode === 403 ||
        errorType === "authentication" ||
        errorType === "permission_denied"
    )
        return new AuthError(message, options);
    if (statusCode === 429 || errorType === "rate_limit_exceeded") {
        return new RateLimitError(message, options);
    }
    if (
        errorType === "context_length_exceeded" ||
        errorType === "max_tokens_exceeded" ||
        errorType === "token_limit_exceeded" ||
        errorType === "string_too_long"
    )
        return new ContextLengthError(message, options);
    if (
        statusCode === 451 ||
        errorType === "content_policy_violation" ||
        errorType === "content_filter"
    )
        return new ContentFilterError(message, options);
    return new ProviderError(message, options);
}

function* normalizeToolDelta(
    tools: Map<number, PendingTool>,
    delta: OpenAIToolCallDelta,
): Iterable<StreamPart> {
    let tool = tools.get(delta.index);
    if (!tool) {
        tool = { id: "", name: "", started: false, pendingArgs: "" };
        tools.set(delta.index, tool);
    }
    if (delta.id) tool.id += delta.id;
    if (delta.function?.name) tool.name += delta.function.name;
    if (delta.function?.arguments) tool.pendingArgs += delta.function.arguments;
    if (!tool.started && tool.id && tool.name) {
        tool.started = true;
        yield { type: "tool-call-start", toolCallId: tool.id, toolName: tool.name };
    }
    if (tool.started && tool.pendingArgs) {
        yield { type: "tool-call-delta", toolCallId: tool.id, argsDelta: tool.pendingArgs };
        tool.pendingArgs = "";
    }
}

function mapFinishReason(
    reason: string,
): "stop" | "length" | "tool-calls" | "content-filter" | "error" | "other" {
    if (reason === "stop") return "stop";
    if (reason === "length") return "length";
    if (reason === "tool_calls" || reason === "function_call") return "tool-calls";
    if (reason === "content_filter") return "content-filter";
    return "other";
}

function mapUsage(raw: NonNullable<OpenAIChatCompletionChunk["usage"]>): Usage {
    return {
        inputTokens: raw.prompt_tokens,
        outputTokens: raw.completion_tokens,
        totalTokens: raw.total_tokens,
        reasoningTokens: raw.completion_tokens_details?.reasoning_tokens,
        cachedInputTokens: raw.prompt_tokens_details?.cached_tokens,
    };
}

async function errorFromResponse(response: Response, provider: string): Promise<Error> {
    const text = await response.text();
    let raw: unknown = text;
    let message = text || `OpenAI-compatible request failed with status ${response.status}.`;
    let code = "";
    try {
        raw = JSON.parse(text);
        const error = (raw as { error?: { message?: string; code?: string; type?: string } }).error;
        message = error?.message ?? message;
        code = `${error?.code ?? error?.type ?? ""}`.toLowerCase();
    } catch {}
    const options = { provider, statusCode: response.status, raw };
    if (response.status === 401 || response.status === 403) return new AuthError(message, options);
    if (response.status === 429) {
        return new RateLimitError(message, {
            ...options,
            retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
        });
    }
    if (
        code.includes("context_length") ||
        /context (?:length|window)|too many tokens/i.test(message)
    ) {
        return new ContextLengthError(message, options);
    }
    if (code.includes("content_filter") || response.status === 451) {
        return new ContentFilterError(message, options);
    }
    return new ProviderError(message, options);
}

function parseRetryAfter(value: string | null): number | undefined {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
    return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}
