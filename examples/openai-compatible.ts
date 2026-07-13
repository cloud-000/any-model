import { createRegistry } from "@any-model/core";
import { openAICompatible } from "@any-model/openai-compat";

const providerId = "openai-compatible";
const baseURL = process.env.OPENAI_COMPAT_BASE_URL ?? "https://api.openai.com/v1";
const modelId = process.env.OPENAI_COMPAT_MODEL_ID ?? "gpt-4o-mini";

const ai = createRegistry().use(
    openAICompatible({
        id: providerId,
        baseURL,
        apiKey: process.env.OPENAI_COMPAT_API_KEY,
    }),
);
const model = ai.languageModel(`${providerId}:${modelId}`);

const result = await model.generate({
    messages: [{ role: "user", content: "Say hello in one short sentence." }],
});

console.log(result.text);
