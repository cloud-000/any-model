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
    /**
     * Per-tool provider escape hatch, e.g. `{ chatgpt: { strict: true } }`.
     * Mirrors GenerateRequest.providerOptions, scoped to one tool.
     */
    providerOptions?: ProviderOptions;
    /**
     * Never present. Declared so a ToolDefinition cannot be passed where a wire
     * Tool is expected — strip it with toWireTools() instead.
     */
    execute?: never;
}

/** The wire fields of `Tool`, without the anti-leak guard. */
export type WireTool = Omit<Tool, "execute">;

export interface ToolDefinition<Result = unknown> extends WireTool {
    /** Called with the model's raw args; validation (if any) runs inside. */
    execute(rawArgs: unknown, ctx: ToolExecutionContext): Promise<Result>;
}

/**
 * Explicit seam for supplying a JSON Schema plus a validator by hand. The normal
 * path is to pass a schema library's object straight to `tool()`; this exists for
 * raw JSON Schema with custom validation, or libraries `tool()` can't convert.
 */
export interface SchemaAdapter<T = unknown> {
    jsonSchema: JSONSchema;
    /** Throws/rejects on invalid input. Async to allow refinements etc. */
    parse(input: unknown): T | Promise<T>;
}

// ---------------------------------------------------------------------------
// Standard Schema (https://standardschema.dev)
// ---------------------------------------------------------------------------

/**
 * The Standard Schema v1 interface, declared structurally rather than depended
 * upon so core stays dependency-free here. Zod, Valibot, ArkType and others
 * implement this, which gives `tool()` type inference and runtime validation
 * for any of them without knowing which one it received.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
    readonly "~standard": StandardSchemaProps<Input, Output>;
}

export interface StandardSchemaProps<Input = unknown, Output = Input> {
    readonly version: 1;
    /** Library identifier, e.g. "zod" / "valibot" / "arktype". */
    readonly vendor: string;
    readonly validate: (
        value: unknown,
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    /** Phantom field carrying the inferred types; never present at runtime. */
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
    /**
     * Proposed spec extension letting a schema convert itself to JSON Schema.
     * Libraries that implement it need no special-casing in `tool()`.
     */
    readonly jsonSchema?:
        | {
              input(options?: unknown): JSONSchema;
              output(options?: unknown): JSONSchema;
          }
        | undefined;
}

export type StandardSchemaResult<Output> =
    | { readonly value: Output; readonly issues?: undefined }
    | { readonly issues: ReadonlyArray<{ readonly message: string }> };

/** The output type a Standard Schema produces after validation. */
export type InferStandardSchema<S> =
    S extends StandardSchemaV1<unknown, infer Output> ? Output : never;

export interface ToolExecutionContext {
    toolCallId: string;
    /** Conversation through the assistant message containing this call, before its results. */
    messages: readonly Message[];
    /** Propagated from GenerateRequest.abortSignal. */
    abortSignal?: AbortSignal;
    /** Request-scoped DI slot (DB handle, tenant id). Hand-constructed by the loop
     *  author; nothing in core populates it. Cast at the use site for now. */
    context?: unknown;
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

// ---------------------------------------------------------------------------
// Live model listing
// ---------------------------------------------------------------------------

/** Options for live model listing on a provider or registry. */
export interface ListModelsOptions {
    abortSignal?: AbortSignal;
    /** Extra HTTP headers merged into the vendor list request, if applicable. */
    headers?: Record<string, string>;
}

/**
 * A model the vendor currently reports as available. Thin on purpose: pricing,
 * context windows, and modalities belong in the catalog package, not here.
 * Round-trip by passing `"${provider}:${id}"` to `languageModel()`.
 */
export interface ModelInfo {
    /** Provider id — the prefix in `"providerId:modelId"`. */
    provider: string;
    /** Model id you'd pass to `languageModel()`; no provider prefix. */
    id: string;
    /** Human-readable name when the vendor supplies one. */
    name?: string;
    ownedBy?: string;
    /** Unix seconds, when the vendor supplies it. */
    created?: number;
    /** Untranslated vendor payload. */
    raw?: unknown;
}
