/**
 * Normalized request/response types shared by every provider.
 *
 * The common surface is unified here; anything provider-specific rides in
 * `providerOptions` (see {@link ProviderOptions}) and is ignored by providers
 * that don't understand it.
 */

/** A JSON Schema object. Kept loose on purpose — providers translate it. */
export type JSONSchema = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Content parts
// ---------------------------------------------------------------------------

export interface TextPart {
    type: "text";
    text: string;
    providerMetadata?: ProviderMetadata;
}

export interface ReasoningPart {
    type: "reasoning";
    text: string;
    providerMetadata?: ProviderMetadata;
}

export interface ImagePart {
    type: "image";
    /** A URL, a base64 string, or raw bytes. */
    image: string | URL | Uint8Array;
    /** e.g. "image/png". Optional when derivable from a data URL. */
    mediaType?: string;
}

export interface FilePart {
    type: "file";
    data: string | URL | Uint8Array;
    mediaType: string;
}

/** A model's request to call a tool. Appears in assistant content and results. */
export interface ToolCallPart {
    type: "tool-call";
    toolCallId: string;
    toolName: string;
    /** Parsed arguments. Providers parse streamed JSON before emitting this. */
    args: unknown;
    providerMetadata?: ProviderMetadata;
}

/** The outcome of executing a tool, fed back to the model. */
export interface ToolResultPart {
    type: "tool-result";
    toolCallId: string;
    toolName: string;
    result: unknown;
    isError?: boolean;
}

export type UserContentPart = TextPart | ImagePart | FilePart;
export type AssistantContentPart = TextPart | ReasoningPart | ToolCallPart;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface SystemMessage {
    role: "system";
    content: string;
}

export interface UserMessage {
    role: "user";
    content: string | UserContentPart[];
}

export interface AssistantMessage {
    role: "assistant";
    content: string | AssistantContentPart[];
}

export interface ToolMessage {
    role: "tool";
    content: ToolResultPart[];
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface Tool {
    name: string;
    description?: string;
    /** JSON Schema for the tool's arguments. */
    inputSchema: JSONSchema;
}

export type ToolChoice = "auto" | "none" | "required" | { type: "tool"; toolName: string };

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export type ResponseFormat =
    | { type: "text" }
    | { type: "json"; schema?: JSONSchema; name?: string };

/**
 * Typed escape hatch for provider-specific features, keyed by provider id,
 * e.g. `{ anthropic: { cacheControl: ... }, openrouter: { provider: {...} } }`.
 * Providers read only their own key and ignore the rest.
 */
export type ProviderOptions = Record<string, Record<string, unknown>>;

/** Provider-native metadata attached to normalized output without changing it. */
export type ProviderMetadata = Record<string, Record<string, unknown>>;

export interface GenerateRequest {
    messages: Message[];
    tools?: Tool[];
    toolChoice?: ToolChoice;
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    responseFormat?: ResponseFormat;
    providerOptions?: ProviderOptions;
    abortSignal?: AbortSignal;
    /** Extra HTTP headers merged into the provider request, if applicable. */
    headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type FinishReason = "stop" | "length" | "tool-calls" | "content-filter" | "error" | "other";

export interface Usage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
}

/** A non-fatal note surfaced to the caller (e.g. a dropped unsupported option). */
export interface Warning {
    type: "unsupported-setting" | "other";
    message: string;
}

export interface GenerateResult {
    /** Ordered content the model produced. */
    content: AssistantContentPart[];
    /** Convenience: all text parts concatenated. */
    text: string;
    /** Convenience: just the tool calls, in order. */
    toolCalls: ToolCallPart[];
    finishReason: FinishReason;
    usage: Usage;
    warnings: Warning[];
    /** Provider-native metadata needed to continue or inspect the result. */
    providerMetadata?: ProviderMetadata;
    /** The raw provider payload, for escape-hatch access. */
    raw?: unknown;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** Structural flags describing what a specific model instance can do. */
export interface Capabilities {
    streaming: boolean;
    tools: boolean;
    vision: boolean;
    jsonSchema: boolean;
    reasoning: boolean;
    promptCaching: boolean;
}
