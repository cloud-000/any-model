import { createRegistry } from "@any-model/core";
import { openRouter } from "@any-model/openrouter";

const apiKey = process.env.OPENROUTER_API_KEY;

if (!apiKey) {
    throw new Error("Set OPENROUTER_API_KEY in examples/.env before running this example.");
}

const ai = createRegistry().use(openRouter({ apiKey }));
const modelId = process.env.OPENROUTER_MODEL_ID ?? "openrouter:openrouter/auto";
const model = ai.languageModel(modelId);

const result = await model.generate({
    messages: [{ role: "user", content: "Say hello in one short sentence." }],
});

console.log(result.text);
