# Examples

These examples consume the workspace packages as a user of the library would.

Create one shared environment file:

```bash
cp examples/.env.example examples/.env
```

Add the API key for the example you want to run, then use its command:

```bash
bun run example:hello
bun run example:gemini
bun run example:openai-compatible
bun run example:tools
```

The OpenRouter example defaults to `openrouter:openrouter/auto`, while the Google example
defaults to `google:gemini-2.5-flash`. Override them with `OPENROUTER_MODEL_ID` and
`GOOGLE_MODEL_ID`, respectively.

The OpenAI-compatible example defaults to OpenAI's `https://api.openai.com/v1` endpoint and
the `gpt-4o-mini` model. Set `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_API_KEY`, and
`OPENAI_COMPAT_MODEL_ID` to target another OpenAI-compatible service. The base URL should
end at the API root; the library appends `/chat/completions`.

The tools example (`tools.ts`) uses the same OpenAI-compatible config and shows the other
half of the tool-calling contract: `tool()` and `toWireTools()` from `@any-model/core`, plus
a small hand-rolled loop that runs a tool's `execute` locally and feeds the result back to
the model as a `ToolResultPart` until it stops asking for tools (or `maxSteps` is hit). The
agent loop itself isn't part of `@any-model/core` by design, so this is one way to write it,
not the only way.
