/**
 * A mock provider for tests — no network. Scriptable per request, or fed a
 * fixed string / list of {@link StreamPart}s. Also the reference example of how
 * little a provider needs to implement: `doStream` plus `listModels`.
 */
import {
    createLanguageModel,
    type Capabilities,
    type GenerateRequest,
    type ModelInfo,
    type Provider,
    type StreamPart,
} from "@any-model/core";

export type MockResponse = string | StreamPart[] | AsyncIterable<StreamPart>;

export interface MockProviderConfig {
    id?: string;
    capabilities?: Partial<Capabilities>;
    /**
     * Decide what a model returns for a given request. Defaults to echoing the
     * last user text (or a canned greeting).
     */
    respond?: (request: GenerateRequest, modelId: string) => MockResponse | Promise<MockResponse>;
    /**
     * Models `listModels()` returns. Strings become `{ provider, id }`.
     * Defaults to `[{ id: "echo" }]`. `provider` is always the mock's id.
     */
    models?: Array<string | Omit<ModelInfo, "provider">>;
}

const ALL_CAPABILITIES: Capabilities = {
    streaming: true,
    tools: true,
    vision: true,
    jsonSchema: true,
    reasoning: true,
    promptCaching: true,
};

export function mockProvider(config: MockProviderConfig = {}): Provider {
    const id = config.id ?? "mock";
    const capabilities = { ...ALL_CAPABILITIES, ...config.capabilities };
    const respond = config.respond ?? defaultRespond;
    const models = (config.models ?? [{ id: "echo" }]).map((model): ModelInfo =>
        typeof model === "string" ? { provider: id, id: model } : { ...model, provider: id },
    );

    return {
        id,
        languageModel(modelId: string) {
            return createLanguageModel({
                provider: id,
                modelId,
                capabilities,
                doStream: (request) => streamFrom(Promise.resolve(respond(request, modelId))),
            });
        },
        listModels: async () => models,
    };
}

// --- Scripting helpers -----------------------------------------------------

/** A text response streamed in chunks, followed by a `finish`. */
export function streamText(text: string, opts: { chunkSize?: number } = {}): StreamPart[] {
    const size = opts.chunkSize ?? Math.max(1, Math.ceil(text.length / 3));
    const parts: StreamPart[] = [];
    for (let i = 0; i < text.length; i += size) {
        parts.push({ type: "text-delta", text: text.slice(i, i + size) });
    }
    parts.push({
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: text.length },
    });
    return parts;
}

/** A single tool call streamed as start/delta/end, followed by a `finish`. */
export function streamToolCall(
    toolName: string,
    args: unknown,
    opts: { toolCallId?: string } = {},
): StreamPart[] {
    const toolCallId = opts.toolCallId ?? `call_${toolName}`;
    const argsText = JSON.stringify(args);
    return [
        { type: "tool-call-start", toolCallId, toolName },
        { type: "tool-call-delta", toolCallId, argsDelta: argsText },
        { type: "tool-call-end", toolCallId, args },
        {
            type: "finish",
            finishReason: "tool-calls",
            usage: { inputTokens: 0, outputTokens: 0 },
        },
    ];
}

// --- Internals -------------------------------------------------------------

function defaultRespond(request: GenerateRequest): MockResponse {
    const last = [...request.messages].reverse().find((m) => m.role === "user");
    const text =
        last && typeof last.content === "string" ? last.content : "Hello from the mock provider.";
    return streamText(text);
}

async function* streamFrom(responsePromise: Promise<MockResponse>): AsyncIterable<StreamPart> {
    const res = await responsePromise;
    if (typeof res === "string") {
        yield* arrayToStream(streamText(res));
        return;
    }
    if (Array.isArray(res)) {
        yield* arrayToStream(res);
        return;
    }
    yield* res;
}

async function* arrayToStream(parts: StreamPart[]): AsyncIterable<StreamPart> {
    let sawFinish = false;
    for (const part of parts) {
        if (part.type === "finish") sawFinish = true;
        yield part;
    }
    if (!sawFinish) {
        yield { type: "finish", finishReason: "stop", usage: {} };
    }
}
