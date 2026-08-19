# Adding a provider package

Reference implementations, in order of usefulness: `packages/testing/src/index.ts` (the
minimum), `packages/openai-compat/src/provider.ts` (a full HTTP + SSE provider),
`packages/openrouter/src/provider.ts` (extending another provider).

## Checklist

1. `packages/<name>/` with `src/index.ts`, `src/provider.ts`, `src/wire.ts`,
   `src/provider.test.ts`, `README.md`, `LICENSE`, `package.json`.
2. `package.json` mirroring the existing ones — see below.
3. Add the directory name to the `packageDirs` list in `scripts/build.ts`.
4. `bun install` (a workspace package only resolves if something depends on it).
5. `bun test` and `bun run typecheck` clean.
6. Update the package table in `README.md` and `llms.txt`, and the roadmap in `CLAUDE.md`.

## package.json

```jsonc
{
    "name": "@any-model/<name>",
    "version": "0.1.0",
    "license": "MIT",
    "type": "module",
    "description": "<Vendor> provider for any-model.",
    "repository": { "type": "git", "url": "git+https://github.com/cloud-000/any-model.git", "directory": "packages/<name>" },
    "homepage": "https://github.com/cloud-000/any-model#readme",
    "bugs": { "url": "https://github.com/cloud-000/any-model/issues" },
    "files": ["dist", "README.md", "LICENSE"],
    "publishConfig": { "access": "public" },
    "scripts": {
        "build": "bun ../../scripts/build.ts",
        "prepublishOnly": "bun ../../scripts/build.ts"
    },
    "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "default": "./dist/index.js" } },
    "devDependencies": { "@any-model/core": "workspace:^" },
    "peerDependencies": { "@any-model/core": "^0.1.0" }
}
```

Core is a **peer** dependency (workspace devDependency for local resolution), never a regular
one — two copies of core in a tree means two copies of the error classes, and `instanceof`
stops working. The build externalizes peer deps plus `@any-model/core` and
`@any-model/openai-compat`.

`src/index.ts` exports the factory, the options helper, the config/options types, and the wire
types — nothing else.

## Shape

```ts
export interface MyConfig {
    apiKey: string;
    baseURL?: string;
    headers?: Record<string, string>;
    capabilities?: Partial<Capabilities>;
    fetch?: FetchFunction;   // injectable: this is how tests avoid the network
}

const DEFAULT_CAPABILITIES: Capabilities = {
    streaming: true, tools: true, vision: false,
    jsonSchema: true, reasoning: false, promptCaching: false,
};

export function myProvider(config: MyConfig): Provider {
    if (!config.apiKey) throw new TypeError("apiKey is required.");
    const fetchImpl = config.fetch ?? globalThis.fetch;
    const capabilities = { ...DEFAULT_CAPABILITIES, ...config.capabilities };

    return {
        id: "my-provider",
        languageModel(modelId) {
            return createLanguageModel({
                provider: "my-provider",
                modelId,
                capabilities,
                doStream: (request) => streamCompletion({ config, fetchImpl, modelId, request }),
            });
        },
        // Live GET /models, or unsupportedListModels("my-provider") if the vendor has none.
        listModels: (options) => listModels({ config, fetchImpl, options }),
    };
}

export function myProviderOptions(options: MyOptions): ProviderOptions {
    return { "my-provider": options };
}
```

Validate config in the factory (throw `TypeError`), resolve `fetch` and capabilities once, and
keep `languageModel` cheap — it's called per model id. `listModels` is required on the
contract; throw `UnsupportedFeatureError("listModels")` via `unsupportedListModels(id)` when
the vendor has no list API. Keep `ModelInfo` thin (`provider`, `id`, optional `name` /
`ownedBy` / `created`) and put vendor extras on `raw`.

## `doStream`

An `async function*` that does the whole request/response cycle:

```ts
async function* streamCompletion(input: {...}): AsyncIterable<StreamPart> {
    const body = makeRequestBody(input.modelId, input.request);      // exported, pure, testable
    const headers = { "content-type": "application/json", ...input.config.headers, ...input.request.headers };

    let response: Response;
    try {
        response = await input.fetchImpl(endpoint, {
            method: "POST", headers, body: JSON.stringify(body),
            signal: input.request.abortSignal,
        });
    } catch (error) {
        if (input.request.abortSignal?.aborted || isAbortError(error)) throw error;  // never wrap aborts
        throw new ProviderError("… request failed.", { provider, cause: error, isRetryable: true });
    }

    if (!response.ok) throw await errorFromResponse(response, provider);
    if (!response.body) throw new ProviderError("… response had no body.", { provider, statusCode: response.status });

    yield* normalizeChunks(parseSSE(response.body, provider), provider);
}
```

Rules:

- **Always stream.** Request the vendor's streaming mode; `generate()` folds it. Never add a
  second non-streaming path.
- Keep `makeRequestBody(modelId, request)` a pure exported function — the request-translation
  tests call it directly with no network.
- Merge headers as: defaults → `config.headers` → `request.headers`. Add auth only if the
  caller hasn't set that header already (case-insensitive check).
- Spread `request.providerOptions?.["my-provider"]` into the body **first**, then the
  normalized fields, and strip fields the normalized surface owns so an escape-hatch value
  can't silently override `messages`/`tools`/`stream`.
- Translate everything the request offers or throw `UnsupportedFeatureError(feature, { provider })`
  for what the vendor can't do (e.g. `FilePart` on a chat-completions endpoint). Silent drops
  are only acceptable via a `Warning`.
- Emit `{ type: "raw", value: chunk }` for each native chunk so callers keep an escape hatch.
- Emit exactly one terminal `finish` with `finishReason` and `usage`. Close out any tool call
  still open with a `tool-call-end` first.
- Tool-call streaming: emit `tool-call-start` as soon as both id and name are known, then
  `tool-call-delta` with raw JSON text fragments, then `tool-call-end` (with parsed `args`
  only if the vendor gives them parsed). `foldStream` handles the rest.
- Vendors that index tool-call deltas rather than naming them per chunk need a
  `Map<index, PendingTool>` accumulator — see `normalizeToolDelta` in openai-compat.

## SSE parsing

Bun-native, no dependency: `response.body.getReader()` + `TextDecoder`, buffer across chunks,
split on `/\r?\n/`, accumulate `data:` lines (stripping one leading space), dispatch on a blank
line, stop at `[DONE]`, and flush the tail after the reader completes. Malformed JSON becomes a
`ProviderError` carrying `raw`. Copy the `parseSSE` helper from openai-compat rather than
reinventing it.

## Error mapping

Map wire errors onto the taxonomy so retry/fallback layers can behave uniformly. Inspect both
HTTP status and the vendor's error `code`/`type` string:

| signal                                              | class                |
| --------------------------------------------------- | -------------------- |
| 401 / 403, `authentication`, `permission_denied`     | `AuthError`          |
| 429, `rate_limit_exceeded` (+ `Retry-After` header)  | `RateLimitError`     |
| `context_length…`, "context window", "too many tokens" | `ContextLengthError` |
| 451, `content_filter`, `content_policy_violation`    | `ContentFilterError` |
| anything else                                        | `ProviderError`      |

Always pass `{ provider, statusCode, raw }`. Parse `Retry-After` as either seconds or an HTTP
date into `retryAfterMs`. Errors that arrive *inside* the stream are yielded as
`{ type: "error", error }` and then the stream ends; errors before the first byte are thrown.

## Tests

`src/provider.test.ts`, `bun:test`, no network — inject `fetch`:

1. **Request translation** — call `makeRequestBody` directly: system/user/assistant/tool
   messages, multimodal parts, tools + `toolChoice`, sampling params, `responseFormat`,
   `providerOptions` passthrough, and protected-field stripping.
2. **Stream normalization** — feed a canned SSE body through a fake `fetch` and assert the
   exact `StreamPart` sequence, including tool-call start/delta/end and the final `finish`
   usage.
3. **Error mapping** — one case per class, asserting `instanceof`, `statusCode`, and
   `retryAfterMs`.
4. **Abort** — an aborted signal rethrows the `AbortError` rather than a `ProviderError`.
5. **listModels** — if the vendor has a list API, fake `fetch` and assert URL, mapping, and
   error classes; otherwise assert `UnsupportedFeatureError` with `feature === "listModels"`.

Live tests against the real API go in `test/live.test.ts`, gated on an env key
(see `packages/openrouter/test/live.test.ts`).

## Style

TypeScript strict, `noUncheckedIndexedAccess` on — handle possibly-undefined indexed access.
Prefer Web-standard APIs over Node built-ins. Comments explain *why* a non-obvious line exists
(the existing providers are the tone to match), not what the code does.
