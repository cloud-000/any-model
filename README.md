# any-model

> One interface for every model provider. Switch models by changing a single string.

`any-model` is a unified, BYOK (bring-your-own-key) interface for AI model providers.
Agentic harnesses and apps shouldn't have to hand-write adapters for OpenRouter, Google AI
Studio, Anthropic, Amazon Bedrock, local OpenAI-compatible endpoints, in-process
`transformers.js`, and the rest. `any-model` normalizes them behind one contract so that
**switching model = changing one line**.

```ts
import { createRegistry } from "@any-model/core";
import { openRouter, openRouterOptions } from "@any-model/openrouter";

const ai = createRegistry().use(
    openRouter({ apiKey: process.env.OPENROUTER_API_KEY! }),
);

// Change this string to switch providers. Nothing else moves.
const model = ai.languageModel("openrouter:anthropic/claude-sonnet-4");

for await (const part of model.stream({
    messages: [{ role: "user", content: "Hi" }],
    providerOptions: openRouterOptions({
        provider: { sort: "latency", allow_fallbacks: true },
    }),
})) {
    if (part.type === "text-delta") process.stdout.write(part.text);
}
```

## Why

Every agentic tool re-solves the same problem: abstract over N provider wire formats,
each with its own auth, message shape, tool-calling dialect, streaming protocol, and
capability quirks. `any-model` does it once, with two goals:

- **Unified & elegant** — one normalized request/response/stream contract across all
  providers, with a typed escape hatch (`providerOptions`) so provider-specific features
  are never lost.
- **Zero bloat** — the core has no provider dependencies. Each provider is its own package
  with its own dependency closure. Install only what you use; the AWS SDK or
  `transformers.js` never lands in your tree unless you ask for it.

## Design at a glance

- **Provider plugins are a contract, not magic.** A provider is a factory returning an
  object that satisfies the core `Provider` interface. Explicit registration keeps
  everything tree-shakeable and type-safe — no auto-discovery, no reflection.
- **One streaming event type.** Every provider normalizes to the same `StreamPart`
  discriminated union (`text-delta`, `reasoning-delta`, tool-call events, `finish`, …).
  Non-streaming `generate()` is just the stream folded into a final result — providers
  implement streaming once.
- **Normalized tool calling.** JSON-Schema (or Zod) tool definitions in; a uniform
  `tool-call` shape out, regardless of each provider's dialect.
- **Capabilities + catalog.** Each model reports structural capability flags
  (tools, vision, JSON schema, reasoning, prompt caching). Model metadata (context window,
  pricing, modalities) comes from a data-driven catalog.
- **Resilience in core.** Retry/backoff, model fallback chains, logging, and caching are
  opt-in middleware that wrap any model — providers stay dumb.

## Packages

| Package                    | Purpose                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `@any-model/core`          | Types, registry, `StreamPart`, middleware, error taxonomy. No provider deps.          |
| `@any-model/openai-compat` | Base for all OpenAI-shaped endpoints (Groq, Together, DeepSeek, Ollama, vLLM, local). |
| `@any-model/anthropic`     | Anthropic Messages API.                                                               |
| `@any-model/google`        | Google AI Studio / Gemini.                                                            |
| `@any-model/openrouter`    | OpenRouter (extends `openai-compat` with routing options).                            |
| `@any-model/bedrock`       | Amazon Bedrock.                                                                       |
| `@any-model/transformers`  | In-process models via `transformers.js`.                                              |
| `@any-model/registry`      | Model catalog data (context windows, pricing, modalities).                            |
| `@any-model/testing`       | Mock / record-replay provider for tests.                                              |
| `any-model`                | Convenience meta-package: re-exports core + registry to get started fast.             |

## Status

The core contract, testing provider, OpenAI-compatible HTTP provider, and OpenRouter
provider are implemented. Additional native provider wire formats and middleware remain
on the roadmap. See `AGENTS.md` for the current conventions.

## Development

```bash
bun install      # install workspace deps
bun test         # run tests
bun run typecheck # check all packages with strict TypeScript
```

Built with [Bun](https://bun.com) + TypeScript.
