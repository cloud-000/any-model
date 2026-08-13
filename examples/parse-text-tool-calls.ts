import type { ToolCallPart } from "@any-model/core";

/**
 * Parses text-based tool calls from model outputs for models that emit
 * tool calls in plain text rather than native provider tool calls.
 *
 * Supported Formats:
 * 1. <|tool_call_start|>[get_weather(city="San Francisco")]<|tool_call_end|>
 * 2. <function name="get_weather"><param name="city">San Francisco</param></function>
 */
export function parseTextToolCalls(text: string | null | undefined): ToolCallPart[] {
    if (!text || typeof text !== "string") {
        return [];
    }

    const calls: ToolCallPart[] = [];
    let idCounter = 1;

    // Format 1: <|tool_call_start|>[tool_name(key="val", ...)]<|tool_call_end|>
    const format1Regex = /<\|tool_call_start\|>([\s\S]*?)<\|tool_call_end\|>/g;
    let match: RegExpExecArray | null;

    while ((match = format1Regex.exec(text)) !== null) {
        const innerContent = match[1];
        if (!innerContent) continue;

        const inner = innerContent.trim();
        // Match func_name(...) or [func_name(...)]
        const funcRegex = /\[?\s*([a-zA-Z0-9_-]+)\s*\(([\s\S]*?)\)\s*\]?/g;
        let funcMatch: RegExpExecArray | null;

        while ((funcMatch = funcRegex.exec(inner)) !== null) {
            const toolName = funcMatch[1];
            const argsStr = funcMatch[2];
            if (!toolName) continue;

            const args = parseKwargs(argsStr ? argsStr.trim() : "");
            calls.push({
                type: "tool-call",
                toolCallId: `call_text_${Date.now()}_${idCounter++}`,
                toolName,
                args,
            });
        }
    }

    // Format 2: <function name="tool_name"><param name="key">val</param></function>
    const format2Regex = /<function\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/function>/g;
    while ((match = format2Regex.exec(text)) !== null) {
        const toolName = match[1];
        const inner = match[2];
        if (!toolName) continue;

        const args: Record<string, unknown> = {};

        if (inner) {
            const paramRegex = /<param\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/param>/g;
            let paramMatch: RegExpExecArray | null;

            while ((paramMatch = paramRegex.exec(inner)) !== null) {
                const paramName = paramMatch[1];
                const rawVal = paramMatch[2];
                if (!paramName) continue;

                args[paramName] = parseValue(rawVal ? rawVal.trim() : "");
            }
        }

        calls.push({
            type: "tool-call",
            toolCallId: `call_text_${Date.now()}_${idCounter++}`,
            toolName,
            args,
        });
    }

    return calls;
}

/**
 * Parses individual param string values into typed JavaScript primitives or objects.
 */
function parseValue(val: string): unknown {
    if (val === "") return "";

    // Attempt JSON parsing (covers numbers, booleans, null, quoted strings, arrays, objects)
    try {
        return JSON.parse(val);
    } catch {
        // Fallbacks for unquoted string literals
        const lower = val.toLowerCase();
        if (lower === "true") return true;
        if (lower === "false") return false;
        if (lower === "null") return null;

        const num = Number(val);
        if (!isNaN(num) && val.trim() !== "") {
            return num;
        }

        return val;
    }
}

/**
 * Parses keyword arguments in key=value format or JSON format.
 */
function parseKwargs(argsStr: string): Record<string, unknown> {
    if (!argsStr) return {};

    const trimmed = argsStr.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            // Ignore JSON parse errors, fallback to regex key=value parsing
        }
    }

    const args: Record<string, unknown> = {};
    const kvRegex = /([a-zA-Z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\{[^}]*\}|\[[^\]]*\]|[^,)]+))/g;
    let match: RegExpExecArray | null;

    while ((match = kvRegex.exec(argsStr)) !== null) {
        const key = match[1];
        if (!key) continue;

        if (match[2] !== undefined) {
            // Double-quoted string
            args[key] = match[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        } else if (match[3] !== undefined) {
            // Single-quoted string
            args[key] = match[3].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
        } else if (match[4] !== undefined) {
            // Primitive or unquoted value
            args[key] = parseValue(match[4].trim());
        }
    }

    return args;
}
