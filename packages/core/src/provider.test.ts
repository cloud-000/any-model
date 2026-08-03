import { describe, expect, test } from "bun:test";
import { createLanguageModel } from "./provider.ts";
import type { StreamPart } from "./stream.ts";
import { tool } from "./tool.ts";
import type { Capabilities, GenerateRequest, Tool } from "./types.ts";

const CAPABILITIES: Capabilities = {
    streaming: true,
    tools: true,
    vision: false,
    jsonSchema: false,
    reasoning: false,
    promptCaching: false,
};

async function* emptyStream(): AsyncIterable<StreamPart> {
    yield { type: "finish", finishReason: "stop", usage: {} };
}

describe("createLanguageModel tool sanitization", () => {
    const weather = tool({
        name: "weather",
        inputSchema: { type: "object" },
        execute: () => "sunny",
    });

    function requestWith(tools: unknown): GenerateRequest {
        return { messages: [], tools: tools as Tool[] };
    }

    test("stream() strips execute before doStream sees the request", () => {
        let seenTools: Tool[] | undefined;
        const model = createLanguageModel({
            provider: "mock",
            modelId: "m",
            capabilities: CAPABILITIES,
            doStream: (request) => {
                seenTools = request.tools;
                return emptyStream();
            },
        });

        model.stream(requestWith([weather]));
        expect(seenTools).toHaveLength(1);
        expect(seenTools?.[0]).toEqual({
            name: "weather",
            description: undefined,
            inputSchema: { type: "object" },
            providerOptions: undefined,
        });
        expect(seenTools?.[0] && "execute" in seenTools[0]).toBe(false);
    });

    test("generate() strips execute exactly once (not double-stripped)", async () => {
        let seenTools: Tool[] | undefined;
        const model = createLanguageModel({
            provider: "mock",
            modelId: "m",
            capabilities: CAPABILITIES,
            doStream: (request) => {
                seenTools = request.tools;
                return emptyStream();
            },
        });

        await model.generate(requestWith([weather]));
        expect(seenTools).toHaveLength(1);
        expect(seenTools?.[0]).toEqual({
            name: "weather",
            description: undefined,
            inputSchema: { type: "object" },
            providerOptions: undefined,
        });
    });

    test("requests without tools pass through unchanged", async () => {
        let seenRequest: GenerateRequest | undefined;
        const model = createLanguageModel({
            provider: "mock",
            modelId: "m",
            capabilities: CAPABILITIES,
            doStream: (request) => {
                seenRequest = request;
                return emptyStream();
            },
        });

        const request: GenerateRequest = { messages: [] };
        await model.generate(request);
        expect(seenRequest?.tools).toBeUndefined();
    });
});
