---
name: any-model
description: Write, review, or extend code that uses any-model (`@any-model/core`, `@any-model/agent`, `@any-model/openai-compat`, `@any-model/openrouter`, `@any-model/google`, `@any-model/chatgpt`, `@any-model/testing`). Use when calling an LLM through any-model, defining tools with `tool()`, consuming `StreamPart`s, running the `runAgent` loop, mapping provider errors, or adding a new provider package to the monorepo.
---

# any-model

A BYOK, unified interface over model providers: **switching model = changing one string**.
Core has zero provider dependencies; each provider is its own package with its own
dependency closure.

## Mental model

```
createRegistry().use(provider(config))   →  register providers explicitly
  .languageModel("providerId:modelId")   →  LanguageModel (the one-line switch)
    .stream(request)  →  AsyncIterable<StreamPart>   ← what providers implement
    .generate(request) →  Promise<GenerateResult>    ← core-derived: foldStream(stream)
```

A provider implements `doStream` (from which `stream` / `generate` are derived) and
`listModels()` (live vendor listing, or `unsupportedListModels(id)` when the vendor has none).

## Six rules that are not negotiable

1. **Core has no provider deps.** `@any-model/core` = types, registry, stream fold, errors,
   `tool()`. Provider-specific code lives in `packages/<provider>/`.
2. **Hand-rolled `fetch`, never a vendor SDK.** Write against the vendor REST API directly.
   Only genuinely heavy providers (bedrock, transformers.js) may take real dependencies.
3. **One provider = one publishable package** under `packages/*`, scoped `@any-model/*`,
   `peerDependencies` on `@any-model/core`. No subpath exports bundling many providers.
4. **Registration is explicit.** `registry.use(provider())`. No auto-discovery, no reflection.
5. **Never lose provider-specific features.** Anything outside the normalized surface rides
   in `providerOptions`, keyed by provider id, and is ignored by providers that don't know it.
6. **`generate()` is `stream()` folded.** Implement `doStream` and pass it to
   `createLanguageModel()`. Never write a separate `generate()` in a provider.

## Quick start

```ts
import { createRegistry } from "@any-model/core";
import { openRouter, openRouterOptions } from "@any-model/openrouter";

const ai = createRegistry().use(openRouter({ apiKey: process.env.OPENROUTER_API_KEY! }));

// Change this string to switch providers. Nothing else moves.
const model = ai.languageModel("openrouter:anthropic/claude-sonnet-4");

const result = await model.generate({
    messages: [{ role: "user", content: "Say hello." }],
});
console.log(result.text, result.toolCalls, result.usage, result.finishReason);

for await (const part of model.stream({
    messages: [{ role: "user", content: "Say hello." }],
    providerOptions: openRouterOptions({ provider: { sort: "latency" } }),
})) {
    if (part.type === "text-delta") process.stdout.write(part.text);
}
```

Model ids split on the **first** `:` only — `"openrouter:openai/gpt-4o"`, and a model id may
itself contain `:` (`"local:qwen3:8b"`).

## Requests

`GenerateRequest`: `messages` (required), `tools`, `toolChoice`, `temperature`, `topP`,
`maxOutputTokens`, `stopSequences`, `responseFormat`, `providerOptions`, `abortSignal`,
`headers`.

Messages are `system | user | assistant | tool`. `user`/`assistant` content is a string or an
array of parts (`text` / `image` / `file` for user; `text` / `reasoning` / `tool-call` for
assistant). A `tool` message carries `ToolResultPart[]`. Full type surface:
[references/api.md](references/api.md).

## Streaming

Every provider normalizes to one `StreamPart` union — handle it with a `switch` on `type`:

| part                                          | meaning                                        |
| --------------------------------------------- | ---------------------------------------------- |
| `text-delta` / `reasoning-delta` `{ text }`   | visible / thinking text                        |
| `tool-call-start` `{ toolCallId, toolName }`  | a tool call began                              |
| `tool-call-delta` `{ toolCallId, argsDelta }` | a chunk of args as **raw JSON text**           |
| `tool-call-end` `{ toolCallId, args? }`       | `args` only if the provider parsed them itself |
| `finish` `{ finishReason, usage }`            | terminal (once)                                |
| `error` `{ error }`                           | in-stream failure; stream then ends            |
| `raw` `{ value }`                             | provider-native passthrough                    |

`foldStream(stream)` accumulates all of that into a `GenerateResult` — concatenating text in
order, merging tool-call events by id, and `JSON.parse`-ing accumulated `argsDelta` when
`tool-call-end` carried no `args`. Consumers rarely call it; `generate()` already is it.

## Tools

Declare the schema once; `tool()` derives the wire JSON Schema, the runtime validation, and
the argument type of `execute`:

```ts
import { tool, toWireTools } from "@any-model/core";
import { z } from "zod";

const getWeather = tool({
    name: "get_weather",
    description: "Get the current weather for a city.",
    inputSchema: z.object({ city: z.string().describe("City name, e.g. San Francisco") }),
    execute: ({ city }) => ({ city, tempF: 72 }), // city: string, inferred
});
```

- `inputSchema` accepts a **Standard Schema** (Zod, Valibot, ArkType — the normal path), a
  `SchemaAdapter` (`{ jsonSchema, parse }`) for hand-written schemas, or a bare `JSONSchema`
  (no validation; `execute` gets `unknown`).
- `execute` may close over anything (DB handles, fetch clients). It **cannot** reach a
  provider: `Tool.execute?: never` makes the wire type structurally reject a `ToolDefinition`.
- Crossing to the wire is one call: `model.generate({ messages, tools: toWireTools(tools) })`.
  `runAgent` does this for you — pass it `ToolDefinition[]` directly.
- Bad model args throw `ToolInputError` from `execute`. That is not a crash: feed the message
  back as `{ type: "tool-result", isError: true }` so the model can self-correct.

## Agent loop

`@any-model/agent` is the normalized model/tool loop; it is deliberately **not** in core.

```ts
import { runAgent } from "@any-model/agent";

const result = await runAgent({
    model,
    instructions: "Use tools when needed, then answer concisely.", // prepended, non-mutating
    messages: [{ role: "user", content: "Weather in SF?" }],
    tools: [getWeather],
    maxSteps: 5, // default 8
    onStreamPart({ part, stepNumber }) {
        if (part.type === "text-delta") process.stdout.write(part.text);
    },
});
// result.text, result.messages (full transcript), result.steps, result.usage, result.stopReason
```

Stops when the model emits no tool calls (`"completed"`), at `maxSteps`, on a `stopWhen` hook
(`"custom"`), or on abort (`"aborted"`). Multiple calls in one response run in parallel unless
`toolExecution: "sequential"`. Policy, logging, per-step model/option swaps, and tool-call
limits go in `extensions` — see [references/agent.md](references/agent.md).

The agent executes **only native normalized tool calls**; parsing tool syntax out of model
text is an opt-in concern for the caller (see `examples/parse-text-tool-calls.ts`).

## Errors

All errors extend `AnyModelError` (`provider`, `statusCode`, `raw`, `isRetryable`). Catch by
class, never by string matching:

`AuthError` (401/403) · `RateLimitError` (429, `retryAfterMs`, retryable) ·
`ContextLengthError` · `ContentFilterError` · `UnsupportedFeatureError(feature)` ·
`ToolInputError(toolName)` · `ProviderError` (transport/5xx, retryable when it says so).

Retry/fallback/caching middleware is on the roadmap but **not implemented** — don't reference
it as if it exists; write the retry at the call site or as an agent extension for now.

## Testing

No network in unit tests. `@any-model/testing` scripts responses and doubles as the reference
minimal provider:

```ts
import { mockProvider, streamText, streamToolCall } from "@any-model/testing";

const ai = createRegistry().use(
    mockProvider({ respond: (req, modelId) => streamToolCall("get_weather", { city: "SF" }) }),
);
```

Tests live beside code as `*.test.ts`. Live provider tests are gated behind env keys
(`packages/openrouter/test/live.test.ts`). Cross-package test imports need a `devDependency`
entry plus `bun install` — a Bun workspace package only resolves if something depends on it.

## Commands

`bun install` · `bun test` · `bun run typecheck` (strict, `noUncheckedIndexedAccess` on —
handle possibly-undefined indexed access) · `bun run build` · `bun run example:hello` (also
`:gemini`, `:openai-compatible`, `:tools`, `:agent`, `:agent-hooks`, `:chatgpt`).

Bun everywhere; prefer Web-standard APIs (`fetch`, `ReadableStream`, `TextDecoderStream`) over
Node built-ins.

## References

- [references/api.md](references/api.md) — full core type surface: messages, request/result,
  stream parts, capabilities, errors, `tool()` dispatch.
- [references/providers.md](references/providers.md) — per-package config and
  `providerOptions` for openai-compat, openrouter, google, chatgpt, testing.
- [references/agent.md](references/agent.md) — `runAgent` input/result, extension hooks,
  stateful extensions via `createRun`, streaming and error handling.
- [references/authoring-a-provider.md](references/authoring-a-provider.md) — checklist and
  template for a new provider package: package.json, `doStream`, SSE parsing, error mapping,
  tests.

Existing packages: `core`, `agent`, `openai-compat`, `openrouter`, `google`, `chatgpt`,
`testing`. Planned but **not yet built**: `anthropic`, `bedrock`, `transformers`, `registry`
(model catalog), and the `any-model` meta-package — don't import them.
