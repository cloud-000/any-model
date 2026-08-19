export interface GoogleInteractionRequest {
    [key: string]: unknown;
    model: string;
    input: unknown[];
    stream: true;
}

export interface GoogleInteractionUsage {
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_tokens?: number;
    total_thought_tokens?: number;
    total_cached_tokens?: number;
}

export interface GoogleInteraction {
    id?: string;
    status?: string;
    usage?: GoogleInteractionUsage;
    steps?: Array<Record<string, unknown>>;
    error?: GoogleApiError;
    [key: string]: unknown;
}

export interface GoogleApiError {
    code?: number;
    status?: string;
    message?: string;
    [key: string]: unknown;
}

export interface GoogleInteractionEvent {
    event_type?: string;
    type?: string;
    index?: number;
    step?: Record<string, unknown>;
    delta?: Record<string, unknown>;
    interaction?: GoogleInteraction;
    error?: GoogleApiError;
    [key: string]: unknown;
}

export interface GoogleModel {
    name?: string;
    displayName?: string;
    [key: string]: unknown;
}

export interface GoogleListModelsResponse {
    models?: GoogleModel[];
    nextPageToken?: string;
    [key: string]: unknown;
}
