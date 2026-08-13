import type {
    GenerateRequest,
    Message,
    Usage,
} from "@any-model/core";
import { toWireTools } from "@any-model/core";
import type { AgentRunInput, AgentRunResult, AgentStep } from "./types.ts";
import { createExtensionRuntime, hookContext } from "./extensions.ts";
import { generateStep } from "./generation.ts";
import { executeToolCalls, indexTools } from "./tool-execution.ts";

const DEFAULT_MAX_STEPS = 8;

/** Run model/tool steps until the model stops calling tools or a stop condition is reached. */
export async function runAgent<AppContext = unknown>(
    input: AgentRunInput<AppContext>,
): Promise<AgentRunResult> {
    const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
        throw new RangeError("maxSteps must be a positive integer");
    }

    const tools = [...(input.tools ?? [])];
    const toolsByName = indexTools(tools);
    const wireTools = toWireTools(tools);
    const messages: Message[] = [
        ...(input.instructions === undefined
            ? []
            : [{ role: "system" as const, content: input.instructions }]),
        ...input.messages,
    ];
    const steps: AgentStep[] = [];
    let usage: Usage = {};
    let latestText = "";
    let stopReason: AgentRunResult["stopReason"] = "max-steps";

    const extensions = await createExtensionRuntime(input.extensions ?? [], {
        model: input.model,
        messages: [...messages],
        context: input.context,
        abortSignal: input.abortSignal,
    });

    try {
        for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber++) {
            if (input.abortSignal?.aborted) {
                stopReason = "aborted";
                break;
            }

            const baseContext = hookContext(
                input.model,
                messages,
                steps,
                stepNumber,
                input.context,
                input.abortSignal,
            );
            const prepared = await extensions.prepareStep(baseContext, input.model, {
                ...(input.generateOptions ?? {}),
            });
            const { model, generateOptions } = prepared;

            await extensions.emit({ type: "step-start", stepNumber, model });
            const inputMessages = [...messages];
            const request: GenerateRequest = {
                ...generateOptions,
                messages: inputMessages,
                ...(wireTools.length === 0 ? {} : { tools: wireTools }),
                abortSignal: input.abortSignal,
            };
            const response = await generateStep({
                model,
                request,
                stepNumber,
                onStreamPart: input.onStreamPart,
            });
            latestText = response.text;
            usage = addUsage(usage, response.usage);
            messages.push({ role: "assistant", content: response.content });
            await extensions.emit({ type: "model-finish", stepNumber, response });

            const toolResults = await executeToolCalls({
                calls: response.toolCalls,
                toolsByName,
                extensions,
                model,
                messages,
                steps,
                stepNumber,
                context: input.context,
                abortSignal: input.abortSignal,
                mode: input.toolExecution ?? "parallel",
                formatToolError: input.formatToolError,
            });

            if (toolResults.length > 0) messages.push({ role: "tool", content: toolResults });

            const step: AgentStep = {
                stepNumber,
                model,
                inputMessages,
                response,
                toolResults,
            };
            steps.push(step);
            await extensions.emit({ type: "step-finish", step });

            const afterStepContext = hookContext(
                model,
                messages,
                steps,
                stepNumber,
                input.context,
                input.abortSignal,
            );
            if (await extensions.shouldStop(afterStepContext)) {
                stopReason = "custom";
                break;
            }
            if (response.toolCalls.length === 0) {
                stopReason = "completed";
                break;
            }
        }
    } catch (error) {
        if (!input.abortSignal?.aborted) throw error;
        stopReason = "aborted";
    }

    const result: AgentRunResult = {
        text: latestText,
        messages,
        steps,
        usage,
        stopReason,
    };
    await extensions.emit({ type: "finish", result });
    return result;
}

function addUsage(total: Usage, next: Usage): Usage {
    return {
        ...sumField(total, next, "inputTokens"),
        ...sumField(total, next, "outputTokens"),
        ...sumField(total, next, "totalTokens"),
        ...sumField(total, next, "reasoningTokens"),
        ...sumField(total, next, "cachedInputTokens"),
    };
}

function sumField<K extends keyof Usage>(a: Usage, b: Usage, key: K): Pick<Usage, K> | object {
    const left = a[key];
    const right = b[key];
    return left === undefined && right === undefined
        ? {}
        : ({ [key]: (left ?? 0) + (right ?? 0) } as Pick<Usage, K>);
}
