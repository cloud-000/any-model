import { describe, expect, test } from "bun:test";
import { parseTextToolCalls } from "./parse-text-tool-calls";

describe("parseTextToolCalls", () => {
    test("handles null, undefined, and non-string inputs safely", () => {
        expect(parseTextToolCalls(null)).toEqual([]);
        expect(parseTextToolCalls(undefined)).toEqual([]);
        expect(parseTextToolCalls("")).toEqual([]);
    });

    test("parses format 1: <|tool_call_start|>[get_weather(city=\"San Francisco\")]<|tool_call_end|>", () => {
        const text = '<|tool_call_start|>[get_weather(city="San Francisco")]<|tool_call_end|>';
        const calls = parseTextToolCalls(text);
        expect(calls).toHaveLength(1);
        expect(calls[0].toolName).toBe("get_weather");
        expect(calls[0].args).toEqual({ city: "San Francisco" });
    });

    test("parses format 1 with multiple arguments and types", () => {
        const text = '<|tool_call_start|>[get_weather(city="San Francisco", days=5, alert=true)]<|tool_call_end|>';
        const calls = parseTextToolCalls(text);
        expect(calls).toHaveLength(1);
        expect(calls[0].toolName).toBe("get_weather");
        expect(calls[0].args).toEqual({ city: "San Francisco", days: 5, alert: true });
    });

    test("parses format 2: <function name=\"get_weather\"><param name=\"city\">San Francisco</param></function>", () => {
        const text = '<function name="get_weather"><param name="city">San Francisco</param></function>';
        const calls = parseTextToolCalls(text);
        expect(calls).toHaveLength(1);
        expect(calls[0].toolName).toBe("get_weather");
        expect(calls[0].args).toEqual({ city: "San Francisco" });
    });

    test("parses format 2 with multiple params and typed values", () => {
        const text = '<function name="get_weather"><param name="city">San Francisco</param><param name="days">7</param><param name="detailed">true</param></function>';
        const calls = parseTextToolCalls(text);
        expect(calls).toHaveLength(1);
        expect(calls[0].toolName).toBe("get_weather");
        expect(calls[0].args).toEqual({ city: "San Francisco", days: 7, detailed: true });
    });
});
