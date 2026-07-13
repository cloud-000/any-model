import { describe, expect, test } from "bun:test";
import { foldStream, type StreamPart } from "./stream.ts";

async function* fromParts(parts: StreamPart[]): AsyncIterable<StreamPart> {
    for (const p of parts) yield p;
}

describe("foldStream", () => {
    test("merges consecutive text deltas and separates reasoning", async () => {
        const result = await foldStream(
            fromParts([
                { type: "reasoning-delta", text: "think " },
                { type: "reasoning-delta", text: "hard" },
                { type: "text-delta", text: "Hel" },
                { type: "text-delta", text: "lo" },
                { type: "finish", finishReason: "stop", usage: { outputTokens: 2 } },
            ]),
        );

        expect(result.text).toBe("Hello");
        expect(result.content).toEqual([
            { type: "reasoning", text: "think hard" },
            { type: "text", text: "Hello" },
        ]);
        expect(result.usage.outputTokens).toBe(2);
    });

    test("parses streamed tool-call arg deltas when no parsed args given", async () => {
        const result = await foldStream(
            fromParts([
                { type: "tool-call-start", toolCallId: "c1", toolName: "search" },
                { type: "tool-call-delta", toolCallId: "c1", argsDelta: '{"q":' },
                { type: "tool-call-delta", toolCallId: "c1", argsDelta: '"cats"}' },
                { type: "tool-call-end", toolCallId: "c1" },
                { type: "finish", finishReason: "tool-calls", usage: {} },
            ]),
        );

        expect(result.toolCalls[0]?.args).toEqual({ q: "cats" });
    });

    test("prefers parsed args from tool-call-end over streamed text", async () => {
        const result = await foldStream(
            fromParts([
                { type: "tool-call-start", toolCallId: "c1", toolName: "x" },
                { type: "tool-call-delta", toolCallId: "c1", argsDelta: "garbage" },
                { type: "tool-call-end", toolCallId: "c1", args: { ok: true } },
                { type: "finish", finishReason: "tool-calls", usage: {} },
            ]),
        );

        expect(result.toolCalls[0]?.args).toEqual({ ok: true });
    });

    test("rethrows an error part", async () => {
        const boom = new Error("boom");
        await expect(foldStream(fromParts([{ type: "error", error: boom }]))).rejects.toBe(boom);
    });

    test("preserves provider metadata boundaries, finish metadata, and last raw event", async () => {
        const first = { google: { signature: "sig-1" } };
        const second = { google: { signature: "sig-2" } };
        const result = await foldStream(
            fromParts([
                { type: "reasoning-delta", text: "one", providerMetadata: first },
                { type: "reasoning-delta", text: "two", providerMetadata: second },
                { type: "raw", value: { event: 1 } },
                { type: "raw", value: { event: 2 } },
                {
                    type: "finish",
                    finishReason: "stop",
                    usage: {},
                    providerMetadata: { google: { interactionId: "int-1" } },
                },
            ]),
        );

        expect(result.content).toEqual([
            { type: "reasoning", text: "one", providerMetadata: first },
            { type: "reasoning", text: "two", providerMetadata: second },
        ]);
        expect(result.providerMetadata).toEqual({ google: { interactionId: "int-1" } });
        expect(result.raw).toEqual({ event: 2 });
    });
});
