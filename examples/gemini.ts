import { createRegistry } from "@any-model/core";
import { google } from "@any-model/google";

const apiKey = process.env.GOOGLE_API_KEY;

if (!apiKey) {
    throw new Error("Set GOOGLE_API_KEY in examples/.env before running this example.");
}

const ai = createRegistry().use(google({ apiKey }));
const modelId = process.env.GOOGLE_MODEL_ID ?? "google:gemma-4-26b-a4b-it";
const model = ai.languageModel(modelId);

const result = await model.generate({
    messages: [{ role: "user", content: "Say hello in one short sentence." }],
});

console.log(result.text);
