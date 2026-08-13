import {
    foldStream,
    type GenerateRequest,
    type GenerateResult,
    type LanguageModel,
    type StreamPart,
} from "@any-model/core";
import type { AgentRunInput, AgentStreamPart } from "./types.ts";

interface GenerateStepInput<AppContext> {
    model: LanguageModel;
    request: GenerateRequest;
    stepNumber: number;
    onStreamPart: AgentRunInput<AppContext>["onStreamPart"];
}

/** Stream one model step to the caller while folding it into its final result. */
export function generateStep<AppContext>(
    input: GenerateStepInput<AppContext>,
): Promise<GenerateResult> {
    if (!input.onStreamPart) return input.model.generate(input.request);
    return foldStream(tapStream(input));
}

async function* tapStream<AppContext>(
    input: GenerateStepInput<AppContext>,
): AsyncIterable<StreamPart> {
    for await (const part of input.model.stream(input.request)) {
        const streamPart: AgentStreamPart = {
            stepNumber: input.stepNumber,
            model: input.model,
            part,
        };
        await input.onStreamPart!(streamPart);
        yield part;
    }
}
