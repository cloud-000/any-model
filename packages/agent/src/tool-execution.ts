import type {
    LanguageModel,
    Message,
    ToolCallPart,
    ToolDefinition,
    ToolResultPart,
} from "@any-model/core";
import { hookContext, type AgentExtensionRuntime } from "./extensions.ts";
import type { AgentRunInput, AgentStep, AgentToolCallContext } from "./types.ts";

export function indexTools(tools: readonly ToolDefinition[]): Map<string, ToolDefinition> {
    const indexed = new Map<string, ToolDefinition>();
    for (const tool of tools) {
        if (indexed.has(tool.name)) throw new Error(`Duplicate tool name: "${tool.name}"`);
        indexed.set(tool.name, tool);
    }
    return indexed;
}

interface ExecuteToolCallsInput<AppContext> {
    calls: readonly ToolCallPart[];
    toolsByName: ReadonlyMap<string, ToolDefinition>;
    extensions: AgentExtensionRuntime<AppContext>;
    model: LanguageModel;
    messages: readonly Message[];
    steps: readonly AgentStep[];
    stepNumber: number;
    context: AppContext | undefined;
    abortSignal: AbortSignal | undefined;
    mode: "parallel" | "sequential";
    formatToolError: AgentRunInput<AppContext>["formatToolError"];
}

export async function executeToolCalls<AppContext>(
    input: ExecuteToolCallsInput<AppContext>,
): Promise<ToolResultPart[]> {
    const execute = (call: ToolCallPart) => executeToolCall(input, call);
    if (input.mode === "parallel") return Promise.all(input.calls.map(execute));

    const results: ToolResultPart[] = [];
    for (const call of input.calls) results.push(await execute(call));
    return results;
}

async function executeToolCall<AppContext>(
    input: ExecuteToolCallsInput<AppContext>,
    call: ToolCallPart,
): Promise<ToolResultPart> {
    const context: AgentToolCallContext<AppContext> = {
        ...hookContext(
            input.model,
            input.messages,
            input.steps,
            input.stepNumber,
            input.context,
            input.abortSignal,
        ),
        toolCall: call,
    };
    await input.extensions.emit({
        type: "tool-start",
        stepNumber: input.stepNumber,
        toolCall: call,
    });

    const decision = await input.extensions.beforeToolCall(context);

    let toolResult: ToolResultPart;
    const tool = input.toolsByName.get(call.toolName);
    if (decision?.action === "deny") {
        toolResult = errorResult(call, decision.reason ?? `Tool call denied: ${call.toolName}`);
    } else if (!tool) {
        toolResult = errorResult(call, `Unknown tool: ${call.toolName}`);
    } else {
        try {
            const result = await tool.execute(call.args, {
                toolCallId: call.toolCallId,
                messages: input.messages,
                abortSignal: input.abortSignal,
                context: input.context,
            });
            toolResult = resultPart(call, result);
        } catch (error) {
            if (input.abortSignal?.aborted) throw error;
            const errorValue = input.formatToolError
                ? input.formatToolError(error, context)
                : defaultErrorValue(error);
            toolResult = errorResult(call, errorValue);
        }
    }

    const resultContext = { ...context, toolResult };
    await input.extensions.afterToolCall(resultContext);
    await input.extensions.emit({ type: "tool-finish", stepNumber: input.stepNumber, toolResult });
    return toolResult;
}

function resultPart(call: ToolCallPart, result: unknown): ToolResultPart {
    return {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        result,
    };
}

function errorResult(call: ToolCallPart, result: unknown): ToolResultPart {
    return { ...resultPart(call, result), isError: true };
}

function defaultErrorValue(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
