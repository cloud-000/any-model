/**
 * The provider plugin contract. A provider is a factory returning an object
 * satisfying {@link Provider}; models satisfy {@link LanguageModel}. Providers
 * implement streaming only — {@link createLanguageModel} derives `generate()`
 * by folding the stream.
 */
import { foldStream, type StreamPart } from "./stream.ts";
import { toWireTools } from "./tool.ts";
import type { Capabilities, GenerateRequest, GenerateResult } from "./types.ts";

export interface LanguageModel {
    readonly provider: string;
    readonly modelId: string;
    readonly capabilities: Capabilities;
    generate(request: GenerateRequest): Promise<GenerateResult>;
    stream(request: GenerateRequest): AsyncIterable<StreamPart>;
}

export interface Provider {
    /** Stable id used as the prefix in "providerId:modelId". */
    readonly id: string;
    languageModel(modelId: string): LanguageModel;
}

export interface LanguageModelSpec {
    provider: string;
    modelId: string;
    capabilities: Capabilities;
    /** The single method a provider implements: produce a normalized stream. */
    doStream(request: GenerateRequest): AsyncIterable<StreamPart>;
}

/**
 * Build a {@link LanguageModel} from a provider's `doStream`. `stream()` is
 * `doStream` directly; `generate()` is the folded stream. Provider authors
 * should use this rather than implementing `generate` separately.
 */
export function createLanguageModel(spec: LanguageModelSpec): LanguageModel {
    // One sanitizer, not two: generate() is foldStream(doStream(...)), so
    // sanitizing in both places would strip twice.
    const toWireRequest = (request: GenerateRequest): GenerateRequest =>
        request.tools ? { ...request, tools: toWireTools(request.tools) } : request;

    return {
        provider: spec.provider,
        modelId: spec.modelId,
        capabilities: spec.capabilities,
        stream: (request) => spec.doStream(toWireRequest(request)),
        generate: (request) => foldStream(spec.doStream(toWireRequest(request))),
    };
}
