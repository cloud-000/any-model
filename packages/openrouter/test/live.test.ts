import { expect, test } from "bun:test";
import { openRouter } from "@any-model/openrouter";

const apiKey = process.env.OPENROUTER_API_KEY;

test.skipIf(!apiKey)("streams a live OpenRouter response", async () => {
    const result = await openRouter({ apiKey: apiKey! })
        .languageModel("openrouter/auto")
        .generate({ messages: [{ role: "user", content: "Reply with hello." }] });
    expect(result.text.length).toBeGreaterThan(0);
});
