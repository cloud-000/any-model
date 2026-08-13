import { describe, expect, test } from "bun:test";
import { tool, type StreamPart } from "@any-model/core";
import {
    mockProvider,
    streamText,
    streamToolCall,
    type MockProviderConfig,
} from "@any-model/testing";
import { runAgent } from "./run-agent.ts";
import type { AgentEvent, AgentExtension } from "./types.ts";

function modelWith(
    respond: MockProviderConfig["respond"],
) {
    return mockProvider({ respond }).languageModel("test");
}

describe("runAgent", () => {
    test("returns a complete transcript for a text-only run without mutating input", async () => {
        const original = [{ role: "user" as const, content: "hello" }];
        const result = await runAgent({
            model: modelWith(() => streamText("hi")),
            instructions: "Be concise.",
            messages: original,
        });

        expect(original).toEqual([{ role: "user", content: "hello" }]);
        expect(result.stopReason).toBe("completed");
        expect(result.text).toBe("hi");
        expect(result.steps).toHaveLength(1);
        expect(result.messages).toEqual([
            { role: "system", content: "Be concise." },
            { role: "user", content: "hello" },
            { role: "assistant", content: [{ type: "text", text: "hi" }] },
        ]);
        expect(result.usage.outputTokens).toBe(2);
    });

    test("streams normalized generation parts from every model step", async () => {
        let request = 0;
        const streamed: Array<{ stepNumber: number; type: StreamPart["type"]; text?: string }> = [];
        const result = await runAgent({
            model: modelWith(() => {
                request++;
                return request === 1
                    ? streamToolCall("lookup", { id: 1 })
                    : streamText("done", { chunkSize: 2 });
            }),
            messages: [{ role: "user", content: "go" }],
            tools: [tool({
                name: "lookup",
                inputSchema: { type: "object" },
                execute: () => ({ found: true }),
            })],
            async onStreamPart({ stepNumber, model, part }) {
                expect(model.modelId).toBe("test");
                await Promise.resolve();
                streamed.push({
                    stepNumber,
                    type: part.type,
                    ...(part.type === "text-delta" ? { text: part.text } : {}),
                });
            },
        });

        expect(streamed.map(({ stepNumber, type }) => [stepNumber, type])).toEqual([
            [1, "tool-call-start"],
            [1, "tool-call-delta"],
            [1, "tool-call-end"],
            [1, "finish"],
            [2, "text-delta"],
            [2, "text-delta"],
            [2, "finish"],
        ]);
        expect(streamed.filter((part) => part.text).map((part) => part.text)).toEqual(["do", "ne"]);
        expect(result.text).toBe("done");
        expect(result.stopReason).toBe("completed");
    });

    test("executes a tool, passes run context, and feeds its result into the next step", async () => {
        let requests = 0;
        let toolMessages = 0;
        const model = modelWith((request) => {
            requests++;
            toolMessages = request.messages.filter((message) => message.role === "tool").length;
            return requests === 1
                ? streamToolCall("weather", { city: "Paris" }, { toolCallId: "call-1" })
                : streamText("Sunny in Paris.");
        });
        const weather = tool({
            name: "weather",
            inputSchema: { type: "object" },
            execute: (args, context) => {
                expect(args).toEqual({ city: "Paris" });
                expect(context.context).toEqual({ tenantId: "acme" });
                expect(context.messages.at(-1)?.role).toBe("assistant");
                return { conditions: "sunny" };
            },
        });

        const result = await runAgent({
            model,
            messages: [{ role: "user", content: "Weather?" }],
            tools: [weather],
            context: { tenantId: "acme" },
        });

        expect(requests).toBe(2);
        expect(toolMessages).toBe(1);
        expect(result.stopReason).toBe("completed");
        expect(result.steps).toHaveLength(2);
        expect(result.steps[0]?.toolResults[0]).toMatchObject({
            toolCallId: "call-1",
            toolName: "weather",
            result: { conditions: "sunny" },
        });
        expect(result.messages.map((message) => message.role)).toEqual([
            "user",
            "assistant",
            "tool",
            "assistant",
        ]);
    });

    test("converts unknown tools and execution failures into error results", async () => {
        let request = 0;
        const model = modelWith(() => {
            request++;
            if (request === 1) return streamToolCall("missing", {});
            if (request === 2) return streamToolCall("broken", {});
            return streamText("recovered");
        });
        const broken = tool({
            name: "broken",
            inputSchema: { type: "object" },
            execute: () => {
                throw new Error("safe failure message");
            },
        });

        const result = await runAgent({
            model,
            messages: [{ role: "user", content: "go" }],
            tools: [broken],
        });

        expect(result.steps[0]?.toolResults[0]).toMatchObject({
            isError: true,
            result: "Unknown tool: missing",
        });
        expect(result.steps[1]?.toolResults[0]).toMatchObject({
            isError: true,
            result: "safe failure message",
        });
        expect(result.stopReason).toBe("completed");
    });

    test("runs calls in parallel while retaining model call order", async () => {
        const parts: StreamPart[] = [
            { type: "tool-call-start", toolCallId: "slow", toolName: "slow" },
            { type: "tool-call-end", toolCallId: "slow", args: {} },
            { type: "tool-call-start", toolCallId: "fast", toolName: "fast" },
            { type: "tool-call-end", toolCallId: "fast", args: {} },
            { type: "finish", finishReason: "tool-calls", usage: {} },
        ];
        const finished: string[] = [];
        const slow = tool({
            name: "slow",
            inputSchema: { type: "object" },
            execute: async () => {
                await Bun.sleep(10);
                finished.push("slow");
                return "slow-result";
            },
        });
        const fast = tool({
            name: "fast",
            inputSchema: { type: "object" },
            execute: () => {
                finished.push("fast");
                return "fast-result";
            },
        });

        const result = await runAgent({
            model: modelWith(() => parts),
            messages: [],
            tools: [slow, fast],
            maxSteps: 1,
        });

        expect(finished).toEqual(["fast", "slow"]);
        expect(result.steps[0]?.toolResults.map((part) => part.toolCallId)).toEqual([
            "slow",
            "fast",
        ]);
        expect(result.stopReason).toBe("max-steps");
    });

    test("runs hooks in order and allows a hook to deny execution", async () => {
        const events: string[] = [];
        let executed = false;
        const guarded = tool({
            name: "guarded",
            inputSchema: { type: "object" },
            execute: () => {
                executed = true;
                return "should not run";
            },
        });
        const first: AgentExtension = {
            onEvent: (event: AgentEvent) => {
                events.push(`first:${event.type}`);
            },
            beforeToolCall: () => ({ action: "allow" }),
        };
        const second: AgentExtension = {
            onEvent: (event: AgentEvent) => {
                events.push(`second:${event.type}`);
            },
            beforeToolCall: () => ({ action: "deny", reason: "approval required" }),
        };

        const result = await runAgent({
            model: modelWith(() => streamToolCall("guarded", {})),
            messages: [],
            tools: [guarded],
            extensions: [first, second],
            maxSteps: 1,
        });

        expect(executed).toBe(false);
        expect(result.steps[0]?.toolResults[0]).toMatchObject({
            isError: true,
            result: "approval required",
        });
        expect(events.slice(0, 4)).toEqual([
            "first:step-start",
            "second:step-start",
            "first:model-finish",
            "second:model-finish",
        ]);
    });

    test("creates isolated extension hooks for concurrent runs", async () => {
        const counts: number[] = [];
        const extension: AgentExtension = {
            createRun() {
                let events = 0;
                return {
                    onEvent(event) {
                        events++;
                        if (event.type === "finish") counts.push(events);
                    },
                };
            },
        };
        const model = modelWith(() => streamText("done"));

        await Promise.all([
            runAgent({ model, messages: [], extensions: [extension] }),
            runAgent({ model, messages: [], extensions: [extension] }),
        ]);

        expect(counts).toEqual([4, 4]);
    });

    test("supports custom stopping and an already-aborted run", async () => {
        const model = modelWith(() => streamToolCall("missing", {}));
        const stopped = await runAgent({
            model,
            messages: [],
            extensions: [{ stopWhen: ({ stepNumber }) => stepNumber === 1 }],
        });
        expect(stopped.stopReason).toBe("custom");

        const controller = new AbortController();
        controller.abort();
        const aborted = await runAgent({
            model,
            messages: [],
            abortSignal: controller.signal,
        });
        expect(aborted.stopReason).toBe("aborted");
        expect(aborted.steps).toHaveLength(0);
    });

    test("rejects invalid limits and duplicate tool names", async () => {
        const model = modelWith(() => streamText("unused"));
        const duplicate = tool({
            name: "same",
            inputSchema: { type: "object" },
            execute: () => null,
        });

        await expect(runAgent({ model, messages: [], maxSteps: 0 })).rejects.toThrow(RangeError);
        await expect(runAgent({
            model,
            messages: [],
            tools: [duplicate, duplicate],
        })).rejects.toThrow(/Duplicate tool name/);
    });
});
