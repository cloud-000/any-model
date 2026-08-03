import { createRegistry, type Message } from "@any-model/core";
import { google } from "@any-model/google";
import { openRouter } from "@any-model/openrouter";
import { openAICompatible } from "@any-model/openai-compat";

let providers = [
    {
        name: "GOOGLE_API_KEY",
        provider: google,
    },
    {
        name: "OPENROUTER_API_KEY",
        provider: openRouter,
    },
];

let ai = createRegistry().use(
    openAICompatible({
        id: "local",
        baseURL: process.env.MODEL_URL!,
    }),
);
for (let p of providers) {
    if (!process.env[p.name]) {
        continue;
    }
    ai = ai.use(
        p.provider({
            apiKey: process.env[p.name]!,
        }),
    );
}

// models I use to test stuff, relatively cheap, etc
// poolside/laguna-xs-2.1:free, google:gemma-4-26b-a4b-it, nvidia/nemotron-nano-9b-v2:free etc
export const model = ai.languageModel(`local:${process.env.MODEL_ID!}`);
