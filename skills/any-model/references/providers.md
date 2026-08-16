# Provider packages

Each package exports a factory `(config) => Provider` plus (where applicable) a typed
`providerOptions` helper. Register with `registry.use(...)`; the provider's `id` is the prefix
in `"providerId:modelId"`.

## `@any-model/openai-compat`

The base for every OpenAI-shaped `/chat/completions` endpoint: OpenAI, Groq, Together,
DeepSeek, Ollama, vLLM, LM Studio, llama.cpp.

```ts
import { openAICompatible } from "@any-model/openai-compat";

const ai = createRegistry().use(
    openAICompatible({
        id: "local",                        // required: you choose the registry prefix
        baseURL: "http://localhost:11434/v1", // required: API root, "/chat/completions" appended
        apiKey: process.env.OPENAI_API_KEY,   // optional → `authorization: Bearer …`
        headers: { "x-org": "acme" },
        capabilities: { reasoning: true },     // Partial<Capabilities> override
        fetch: myFetch,                        // injectable for tests/proxies
    }),
);
ai.languageModel("local:qwen3:8b");
```

Defaults: `streaming`, `tools`, `vision`, `jsonSchema` true; `reasoning`, `promptCaching`
false. `baseURL` must end at the API root — trailing slashes are trimmed. `apiKey` is skipped
if an `authorization` header is already present (case-insensitive).

Behavior worth knowing:

- Always requests `stream: true` with `stream_options: { include_usage: true }`; `generate()`
  is the folded stream.
- `providerOptions[id]` is spread into the request body **minus protected fields**
  (`model`, `messages`, `stream`, `stream_options`, `tools`, `tool_choice`, `temperature`,
  `top_p`, `max_tokens`, `stop`, `response_format`) — set those through `GenerateRequest`.
- `responseFormat: { type: "json", schema }` → `json_schema` with `strict: true`; without a
  schema → `json_object`.
- Reasoning comes from either `delta.reasoning_content` or `delta.reasoning`.
- Every raw SSE chunk is also emitted as a `raw` part.
- `FilePart` input throws `UnsupportedFeatureError("file input")`.

Also exports `makeRequestBody(providerId, modelId, request)` and the wire types
`OpenAIChatCompletionRequest` / `OpenAIChatCompletionChunk` — used by tests and by providers
that extend this one.

## `@any-model/openrouter`

Extends openai-compat with OpenRouter routing. Provider id: `openrouter`.

```ts
import { openRouter, openRouterOptions } from "@any-model/openrouter";

const ai = createRegistry().use(
    openRouter({
        apiKey: process.env.OPENROUTER_API_KEY!, // required
        baseURL, headers, fetch,                  // optional
        appURL: "https://myapp.dev",              // → HTTP-Referer (leaderboard attribution)
        appName: "My App",                        // → X-OpenRouter-Title
        appCategories: ["coding"],                // → X-OpenRouter-Categories (comma-joined)
    }),
);

model.stream({
    messages,
    providerOptions: openRouterOptions({
        models: ["anthropic/claude-sonnet-4", "openai/gpt-4o"], // fallback chain
        route: "fallback",
        provider: {
            sort: "latency",              // "price" | "throughput" | "latency" | { by, partition }
            allow_fallbacks: true,
            order: ["anthropic", "google"],
            only: [], ignore: [],
            require_parameters: true,
            data_collection: "deny",
            zdr: true,
            quantizations: ["fp8"],
            preferred_max_latency: { p90: 2000 },
            max_price: { prompt: 3, completion: 15 },
        },
        plugins: [{ id: "web", enabled: true }],
        transforms: ["middle-out"],
        user: "user-123",
    }),
});
```

`openRouterOptions(o)` just returns `{ openrouter: o }` with types attached. Every option
interface has an index signature, so new OpenRouter fields work before the types catch up.
The factory is a thin wrapper: it builds an `OpenAICompatibleConfig` (id `openrouter`,
`reasoning: true`, attribution headers merged before `config.headers`) and returns
`openAICompatible(...)` — so all openai-compat behavior above applies here too.

## `@any-model/google`

Google AI Studio / Gemini over the native REST interaction API. Provider id: `google`.

```ts
import { google, googleOptions } from "@any-model/google";

const ai = createRegistry().use(google({ apiKey: process.env.GOOGLE_API_KEY! }));
const model = ai.languageModel("google:gemini-2.5-flash");

model.generate({
    messages,
    providerOptions: googleOptions({
        generationConfig: { thinking_level: "high", thinking_summaries: "auto" },
        tools: [{ type: "google_search" }],   // native built-in tools
        previousInteractionId: "…",           // server-side conversation continuation
        store: true,
    }),
});
```

Config: `apiKey` (required), `baseURL`, `headers`, `capabilities`, `fetch`. Also exports
`makeRequestBody(modelId, request)` and the `GoogleInteraction*` wire types.

## `@any-model/chatgpt` (experimental)

ChatGPT subscription auth via the Codex OAuth flow — **not** a stable public OpenAI Platform
contract; wire details can change without notice. Provider id: `chatgpt`.

```ts
import {
    chatGPT, chatGPTOptions, memoryCredentialStore,
    startBrowserLogin, startDeviceCodeLogin,
} from "@any-model/chatgpt";

const credentialStore = memoryCredentialStore(); // swap for keychain/DB in real apps

const login = await startBrowserLogin({ credentialStore });
console.log(`If the browser did not open, visit ${login.authorizationURL}`);
await login.credentials;
// or: const login = await startDeviceCodeLogin({ credentialStore });
//     console.log(login.verificationURI, login.userCode);

const ai = createRegistry().use(chatGPT({ credentialStore })); // same store receives rotated tokens
await credentialStore.clear();                                  // logout is caller-owned
```

`chatGPTOptions({ reasoning: {...}, include: ["…"] })` maps to native Responses fields. Config
is `credentialStore` (required), `baseURL`, `headers`, `capabilities`, `fetch`. This backend
rejects several normalized options — `temperature`, `topP`, `stopSequences`, `responseFormat`,
and `FilePart` input all throw `UnsupportedFeatureError`. Per-tool strictness is supported via
`providerOptions: { chatgpt: { strict: true } }` on either the request or an individual tool.
Credential storage, login UX, and logout are all application-owned: implement
`ChatGPTCredentialStore` yourself for anything beyond a process-lifetime store.

## `@any-model/testing`

```ts
import { mockProvider, streamText, streamToolCall } from "@any-model/testing";

mockProvider({
    id: "mock",                            // default "mock"
    capabilities: { reasoning: true },
    respond: (request, modelId) => "hi",   // string | StreamPart[] | AsyncIterable<StreamPart>
});

streamText("hello world", { chunkSize: 4 });           // text deltas + finish
streamToolCall("get_weather", { city: "SF" }, { toolCallId: "call_1" }); // start/delta/end + finish
```

Default `respond` echoes the last user text. Because it implements only `doStream`, this
package is also the reference example of the minimum a provider must do.

## Multi-provider registries

Registering several providers is the intended shape — the model-id string stays the only
switch:

```ts
let ai = createRegistry().use(openAICompatible({ id: "local", baseURL: process.env.MODEL_URL! }));
if (process.env.GOOGLE_API_KEY) ai = ai.use(google({ apiKey: process.env.GOOGLE_API_KEY }));
if (process.env.OPENROUTER_API_KEY) ai = ai.use(openRouter({ apiKey: process.env.OPENROUTER_API_KEY }));

export const model = ai.languageModel(process.env.MODEL ?? "local:qwen3:8b");
```

`use()` returns the registry, so calls chain; re-registering an id replaces it.
