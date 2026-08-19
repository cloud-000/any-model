# Core API reference (`@any-model/core`)

Source of truth: `packages/core/src/{types,stream,provider,registry,errors,tool}.ts`.
Everything below is exported from the package root.

## Registry

```ts
class Registry {
    use(provider: Provider): this;          // later registration of same id overrides
    provider(id: string): Provider;         // throws, listing registered ids
    languageModel(id: string): LanguageModel; // "providerId:modelId"
    listModels(options?: ListModelsOptions): Promise<readonly ModelInfo[]>;
    listModels(providerId: string, options?: ListModelsOptions): Promise<readonly ModelInfo[]>;
    providerIds(): string[];
}
function createRegistry(): Registry;
```

`languageModel` splits on the **first** `:`; the remainder is the model id, so
`"local:qwen3:8b"` resolves provider `local`, model `qwen3:8b`. Ids without a separator, or
with nothing on either side, throw.

`listModels(providerId)` calls that provider (unknown id throws). `listModels()` concatenates
every registered provider; `UnsupportedFeatureError` is skipped so a provider with no list
API does not poison a multi-provider registry. Any other error fails the call.
`languageModel()` stays unvalidated — listing is discovery, not a gate.

## Provider contract

```ts
interface Provider {
    readonly id: string;                       // the prefix in "providerId:modelId"
    languageModel(modelId: string): LanguageModel;
    listModels(options?: ListModelsOptions): Promise<readonly ModelInfo[]>;
}

interface ListModelsOptions {
    abortSignal?: AbortSignal;
    headers?: Record<string, string>;
}

interface ModelInfo {
    provider: string;   // prefix in "providerId:modelId"
    id: string;         // pass to languageModel(); no prefix
    name?: string;
    ownedBy?: string;
    created?: number;   // unix seconds, if the vendor sends it
    raw?: unknown;      // untranslated vendor object
}

interface LanguageModel {
    readonly provider: string;
    readonly modelId: string;
    readonly capabilities: Capabilities;
    generate(request: GenerateRequest): Promise<GenerateResult>;
    stream(request: GenerateRequest): AsyncIterable<StreamPart>;
}

interface LanguageModelSpec {
    provider: string;
    modelId: string;
    capabilities: Capabilities;
    doStream(request: GenerateRequest): AsyncIterable<StreamPart>;
}

function createLanguageModel(spec: LanguageModelSpec): LanguageModel;
function unsupportedListModels(provider: string): Provider["listModels"];
```

`createLanguageModel` wires `stream = doStream` and `generate = foldStream(doStream(...))`.
Providers that have no list API should use `unsupportedListModels(id)` rather than omitting
the method. Round-trip a listed row with `` languageModel(`${info.provider}:${info.id}`) ``.
Vendor extras (pricing, token limits) stay in `ModelInfo.raw` — do not fold them into
capabilities. The static models.dev catalog is a separate, later package.

## Messages and content parts

```ts
type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

interface SystemMessage    { role: "system";    content: string }
interface UserMessage      { role: "user";      content: string | UserContentPart[] }
interface AssistantMessage { role: "assistant"; content: string | AssistantContentPart[] }
interface ToolMessage      { role: "tool";      content: ToolResultPart[] }

type UserContentPart      = TextPart | ImagePart | FilePart;
type AssistantContentPart = TextPart | ReasoningPart | ToolCallPart;

interface TextPart      { type: "text";      text: string; providerMetadata?: ProviderMetadata }
interface ReasoningPart { type: "reasoning"; text: string; providerMetadata?: ProviderMetadata }
interface ImagePart     { type: "image"; image: string | URL | Uint8Array; mediaType?: string }
interface FilePart      { type: "file";  data:  string | URL | Uint8Array; mediaType: string }

interface ToolCallPart {
    type: "tool-call";
    toolCallId: string;
    toolName: string;
    args: unknown;              // already parsed — providers parse streamed JSON first
    providerMetadata?: ProviderMetadata;
}

interface ToolResultPart {
    type: "tool-result";
    toolCallId: string;
    toolName: string;
    result: unknown;
    isError?: boolean;
}
```

`ImagePart.image` may be an https URL, a `data:` URL, a bare base64 string, or raw bytes.
Bare base64 and `Uint8Array` require `mediaType` (`"image/png"`), otherwise providers throw
`UnsupportedFeatureError`.

To continue a conversation after tool use, push the assistant turn as
`{ role: "assistant", content: result.content }` (the full ordered parts, not `result.text`),
then `{ role: "tool", content: toolResults }`.

## Request

```ts
interface GenerateRequest {
    messages: Message[];
    tools?: Tool[];                       // wire tools — see toWireTools()
    toolChoice?: ToolChoice;
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    responseFormat?: ResponseFormat;
    providerOptions?: ProviderOptions;
    abortSignal?: AbortSignal;
    headers?: Record<string, string>;     // merged into the provider HTTP request
}

type ToolChoice = "auto" | "none" | "required" | { type: "tool"; toolName: string };
type ResponseFormat = { type: "text" } | { type: "json"; schema?: JSONSchema; name?: string };

type ProviderOptions  = Record<string, Record<string, unknown>>; // keyed by provider id
type ProviderMetadata = Record<string, Record<string, unknown>>;
type JSONSchema       = Record<string, unknown>;
```

`providerOptions` is keyed by **provider id**, so `{ openrouter: {...}, google: {...} }` can
travel together and each provider reads only its own key. Provider packages ship a typed
helper (`openRouterOptions`, `googleOptions`, `chatGPTOptions`) that builds the correct key.

## Result

```ts
interface GenerateResult {
    content: AssistantContentPart[];  // ordered, as produced
    text: string;                     // convenience: all text parts concatenated
    toolCalls: ToolCallPart[];        // convenience: just the tool calls, in order
    finishReason: FinishReason;
    usage: Usage;
    warnings: Warning[];
    providerMetadata?: ProviderMetadata;
    raw?: unknown;
}

type FinishReason = "stop" | "length" | "tool-calls" | "content-filter" | "error" | "other";

interface Usage {
    inputTokens?: number; outputTokens?: number; totalTokens?: number;
    reasoningTokens?: number; cachedInputTokens?: number;
}

interface Warning { type: "unsupported-setting" | "other"; message: string }
```

Every `Usage` field is optional — a provider that doesn't report a number omits it. Sum
defensively (`?? 0`).

Don't branch on `finishReason === "tool-calls"` alone to detect tool use; some models emit
calls with a `"stop"` reason. Check `result.toolCalls.length`.

## Stream

```ts
type StreamPart =
    | { type: "text-delta";      text: string; providerMetadata?: ProviderMetadata }
    | { type: "reasoning-delta"; text: string; providerMetadata?: ProviderMetadata }
    | { type: "tool-call-start"; toolCallId: string; toolName: string; providerMetadata?: ProviderMetadata }
    | { type: "tool-call-delta"; toolCallId: string; argsDelta: string }   // raw JSON text
    | { type: "tool-call-end";   toolCallId: string; args?: unknown; providerMetadata?: ProviderMetadata }
    | { type: "finish";          finishReason: FinishReason; usage: Usage; providerMetadata?: ProviderMetadata }
    | { type: "error";           error: unknown }
    | { type: "raw";             value: unknown };

function foldStream(stream: AsyncIterable<StreamPart>): Promise<GenerateResult>;
```

Fold semantics: text and reasoning deltas concatenate in order; tool-call events merge by
`toolCallId`; accumulated `argsDelta` is JSON-parsed at `tool-call-end` unless the provider
already supplied parsed `args`.

## Capabilities

Structural flags a model instance reports. Keep these separate from catalog data (context
window, pricing, modalities), which belongs in the model catalog package.

```ts
interface Capabilities {
    streaming: boolean; tools: boolean; vision: boolean;
    jsonSchema: boolean; reasoning: boolean; promptCaching: boolean;
}
```

Providers define defaults and let callers override via `config.capabilities: Partial<Capabilities>`
— necessary because one OpenAI-compatible endpoint may serve models with different abilities.

## Tools

```ts
interface Tool {                      // the wire shape
    name: string;
    description?: string;
    inputSchema: JSONSchema;
    providerOptions?: ProviderOptions; // per-tool escape hatch
    execute?: never;                   // anti-leak guard, never present at runtime
}

interface ToolDefinition<Result = unknown> extends WireTool {
    execute(rawArgs: unknown, ctx: ToolExecutionContext): Promise<Result>;
}

interface ToolExecutionContext {
    toolCallId: string;
    messages: readonly Message[];  // transcript through the assistant message with this call
    abortSignal?: AbortSignal;     // propagated from GenerateRequest.abortSignal
    context?: unknown;             // request-scoped DI slot; nothing in core populates it
}

function tool<S, Result>(def: {
    name: string; description?: string; inputSchema: S;
    providerOptions?: ProviderOptions;
    execute(args: InferToolArgs<S>, ctx: ToolExecutionContext): Result | Promise<Result>;
}): ToolDefinition<Result>;

function toWireTools(tools: readonly (Tool | ToolDefinition)[]): Tool[];
```

`inputSchema` dispatch order inside `tool()`:

1. **Standard Schema** (`z.object(...)`, Valibot, ArkType) — converted to JSON Schema via the
   schema's own `~standard.jsonSchema.input()` when it implements the spec extension; Zod is
   special-cased through `zod/toJSONSchema` with `io: "input"` and `unrepresentable: "any"`.
   A library implementing neither throws `UnsupportedFeatureError("json-schema-conversion")` —
   wrap it in a `SchemaAdapter`.
2. **`SchemaAdapter`** `{ jsonSchema, parse }` — detected by having *both* fields, so a Zod
   schema (which also has `parse`) is never mistaken for one.
3. **Bare `JSONSchema`** — no validation, `execute` receives `unknown`.

Validation runs inside the generated `execute`, before your callback. Failures become
`ToolInputError`; errors your callback throws pass through untouched.

`toWireTools` is an **allowlist** (`name`, `description`, `inputSchema`, `providerOptions`) —
adding a field to `Tool` means adding it here too; `tool.test.ts` guards this.

Zod is a `peerDependency` of core (`^4`) because of the Zod conversion path — it isn't needed
if you only pass adapters or raw JSON Schema.

## Errors

```ts
class AnyModelError extends Error {
    readonly provider?: string;
    readonly statusCode?: number;
    readonly raw?: unknown;        // raw provider payload
    readonly isRetryable: boolean;
}
```

| class                     | when                                    | retryable                 |
| ------------------------- | --------------------------------------- | ------------------------- |
| `AuthError`               | missing/invalid credentials (401/403)   | no                        |
| `RateLimitError`          | 429; carries `retryAfterMs`             | yes                       |
| `ContextLengthError`      | prompt exceeds the context window        | no (as-is)                |
| `ContentFilterError`      | blocked by a safety filter               | no                        |
| `UnsupportedFeatureError` | `.feature`, e.g. `"file input"`          | no                        |
| `ToolInputError`          | `.toolName`; model args failed schema    | no — feed back as `isError` |
| `ProviderError`           | transport/5xx/catch-all                  | set by constructor        |

Aborts are not wrapped: when `abortSignal` fires, providers rethrow the `AbortError` as-is.
