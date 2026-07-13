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
```

The OpenRouter example defaults to `openrouter:openrouter/auto`, while the Google example
defaults to `google:gemini-2.5-flash`. Override them with `OPENROUTER_MODEL_ID` and
`GOOGLE_MODEL_ID`, respectively.

The OpenAI-compatible example defaults to OpenAI's `https://api.openai.com/v1` endpoint and
the `gpt-4o-mini` model. Set `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_API_KEY`, and
`OPENAI_COMPAT_MODEL_ID` to target another OpenAI-compatible service. The base URL should
end at the API root; the library appends `/chat/completions`.
