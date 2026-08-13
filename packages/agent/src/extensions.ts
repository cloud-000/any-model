import type { LanguageModel, Message } from "@any-model/core";
import type {
    AgentEvent,
    AgentExtension,
    AgentGenerateOptions,
    AgentHookContext,
    AgentRunHooks,
    AgentRunStartContext,
    AgentStep,
    AgentToolCallContext,
    AgentToolDecision,
    AgentToolResultContext,
} from "./types.ts";

/** Invocation-scoped facade over extension initialization and hook dispatch. */
export interface AgentExtensionRuntime<AppContext> {
    prepareStep(
        context: AgentHookContext<AppContext>,
        model: LanguageModel,
        generateOptions: AgentGenerateOptions,
    ): Promise<{ model: LanguageModel; generateOptions: AgentGenerateOptions }>;
    beforeToolCall(
        context: AgentToolCallContext<AppContext>,
    ): Promise<AgentToolDecision | undefined>;
    afterToolCall(context: AgentToolResultContext<AppContext>): Promise<void>;
    shouldStop(context: AgentHookContext<AppContext>): Promise<boolean>;
    emit(event: AgentEvent): Promise<void>;
}

export async function createExtensionRuntime<AppContext>(
    extensions: readonly AgentExtension<AppContext>[],
    context: AgentRunStartContext<AppContext>,
): Promise<AgentExtensionRuntime<AppContext>> {
    const hooks: AgentRunHooks<AppContext>[] = [];
    for (const extension of extensions) {
        hooks.push("createRun" in extension ? await extension.createRun(context) : extension);
    }

    return {
        async prepareStep(context, initialModel, initialOptions) {
            let model = initialModel;
            let generateOptions = initialOptions;
            for (const hook of hooks) {
                const preparation = await hook.prepareStep?.(context);
                if (preparation?.model) model = preparation.model;
                if (preparation?.generateOptions) {
                    generateOptions = { ...generateOptions, ...preparation.generateOptions };
                }
            }
            return { model, generateOptions };
        },

        async beforeToolCall(context) {
            let decision: AgentToolDecision | undefined;
            for (const hook of hooks) {
                const next = await hook.beforeToolCall?.(context);
                if (next?.action === "deny") return next;
                if (next) decision = next;
            }
            return decision;
        },

        async afterToolCall(context) {
            for (const hook of hooks) await hook.afterToolCall?.(context);
        },

        async shouldStop(context) {
            for (const hook of hooks) {
                if (await hook.stopWhen?.(context)) return true;
            }
            return false;
        },

        async emit(event) {
            for (const hook of hooks) await hook.onEvent?.(event);
        },
    };
}

export function hookContext<AppContext>(
    model: LanguageModel,
    messages: readonly Message[],
    steps: readonly AgentStep[],
    stepNumber: number,
    context: AppContext | undefined,
    abortSignal: AbortSignal | undefined,
): AgentHookContext<AppContext> {
    return {
        model,
        messages: [...messages],
        steps: [...steps],
        stepNumber,
        context,
        abortSignal,
    };
}
