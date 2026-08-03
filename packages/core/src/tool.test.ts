import { describe, expect, test } from "bun:test";
import { ToolInputError } from "./errors.ts";
import { tool, toWireTools } from "./tool.ts";
import type {
    SchemaAdapter,
    Tool,
    ToolDefinition,
    ToolExecutionContext,
    WireTool,
} from "./types.ts";

const ctx: ToolExecutionContext = { toolCallId: "call-1", messages: [] };

describe("tool()", () => {
    test("plain JSON Schema tools pass args through untouched", async () => {
        const weather = tool({
            name: "weather",
            inputSchema: { type: "object", properties: { city: { type: "string" } } },
            execute: (args) => `weather for ${(args as { city: string }).city}`,
        });

        expect(await weather.execute({ city: "LA" }, ctx)).toBe("weather for LA");
    });

    test("a SchemaAdapter validates/coerces args before execute runs", async () => {
        const adapter: SchemaAdapter<{ city: string }> = {
            jsonSchema: { type: "object" },
            parse: (input) => {
                const value = input as { city?: unknown };
                if (typeof value.city !== "string") throw new Error("city must be a string");
                return { city: value.city.toUpperCase() };
            },
        };
        let seen: { city: string } | undefined;
        const weather = tool({
            name: "weather",
            inputSchema: adapter,
            execute: (args) => {
                seen = args;
                return "ok";
            },
        });

        await weather.execute({ city: "la" }, ctx);
        expect(seen).toEqual({ city: "LA" });
    });

    test("invalid args throw ToolInputError without invoking execute", async () => {
        const adapter: SchemaAdapter<{ city: string }> = {
            jsonSchema: { type: "object" },
            parse: () => {
                throw new Error("bad input");
            },
        };
        let called = false;
        const weather = tool({
            name: "weather",
            inputSchema: adapter,
            execute: () => {
                called = true;
                return "ok";
            },
        });

        await expect(weather.execute({}, ctx)).rejects.toThrow(ToolInputError);
        expect(called).toBe(false);
    });

    test("errors thrown from execute propagate untouched", async () => {
        const broken = tool({
            name: "broken",
            inputSchema: { type: "object" },
            execute: () => {
                throw new RangeError("boom");
            },
        });

        await expect(broken.execute({}, ctx)).rejects.toThrow(RangeError);
    });
});

describe("toWireTools()", () => {
    test("strips execute and forwards only wire fields", () => {
        const fixture: Required<WireTool> & Pick<ToolDefinition, "execute"> = {
            name: "weather",
            description: "Get the weather",
            inputSchema: { type: "object" },
            providerOptions: { chatgpt: { strict: true } },
            execute: async () => "ok",
        };

        const [wire] = toWireTools([fixture]);
        expect(wire).toEqual({
            name: "weather",
            description: "Get the weather",
            inputSchema: { type: "object" },
            providerOptions: { chatgpt: { strict: true } },
        });
        expect(wire && "execute" in wire).toBe(false);
    });

    test("passes plain Tools through unchanged", () => {
        const plain: Tool = { name: "search", inputSchema: { type: "object" } };
        expect(toWireTools([plain])).toEqual([
            {
                name: "search",
                description: undefined,
                inputSchema: { type: "object" },
                providerOptions: undefined,
            },
        ]);
    });
});

// Type-level: a ToolDefinition[] must not be assignable to Tool[] — the whole
// point of the design is that this is a compile error, not a runtime check.
// @ts-expect-error ToolDefinition is not assignable to Tool (execute leak)
const _leak: Tool[] = [] as ToolDefinition[];
void _leak;
