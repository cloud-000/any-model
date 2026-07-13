import { describe, expect, test } from "bun:test";
import { createRegistry } from "./index.ts";
import { mockProvider, streamToolCall } from "@any-model/testing";

describe("registry", () => {
    test("resolves a model by 'providerId:modelId'", () => {
        const ai = createRegistry().use(mockProvider({ id: "mock" }));
        const model = ai.languageModel("mock:some-model");
        expect(model.provider).toBe("mock");
        expect(model.modelId).toBe("some-model");
    });

    test("model ids may contain ':'", () => {
        const ai = createRegistry().use(mockProvider({ id: "bedrock" }));
        const model = ai.languageModel("bedrock:anthropic:claude");
        expect(model.modelId).toBe("anthropic:claude");
    });

    test("throws for unknown provider", () => {
        const ai = createRegistry();
        expect(() => ai.languageModel("nope:x")).toThrow(/Unknown provider/);
    });

    test.each(["", "mock", "mock:", ":x"])("throws for malformed id %p", (id) => {
        const ai = createRegistry().use(mockProvider());
        expect(() => ai.languageModel(id)).toThrow();
    });
});

describe("end-to-end generate/stream", () => {
    const ai = createRegistry().use(mockProvider({ id: "mock" }));

    test("stream() yields normalized parts and generate() folds them", async () => {
        const model = ai.languageModel("mock:echo");
        const req = {
            messages: [{ role: "user" as const, content: "hello world" }],
        };

        const streamed: string[] = [];
        for await (const part of model.stream(req)) {
            if (part.type === "text-delta") streamed.push(part.text);
        }
        expect(streamed.join("")).toBe("hello world");

        const result = await model.generate(req);
        expect(result.text).toBe("hello world");
        expect(result.finishReason).toBe("stop");
        expect(result.toolCalls).toHaveLength(0);
    });

    test("folds a streamed tool call into a parsed tool-call part", async () => {
        const ai2 = createRegistry().use(
            mockProvider({
                id: "mock",
                respond: () => streamToolCall("get_weather", { city: "Paris" }),
            }),
        );
        const result = await ai2.languageModel("mock:tools").generate({
            messages: [{ role: "user", content: "weather?" }],
        });

        expect(result.finishReason).toBe("tool-calls");
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0]).toMatchObject({
            toolName: "get_weather",
            args: { city: "Paris" },
        });
        // Tool call also lands in ordered content.
        expect(result.content.at(-1)?.type).toBe("tool-call");
    });
});
