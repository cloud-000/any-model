/**
 * Normalized error taxonomy. Providers map their wire errors onto these so
 * harnesses (and middleware like retry/fallback) can react uniformly.
 */

export interface AnyModelErrorOptions {
    provider?: string;
    statusCode?: number;
    cause?: unknown;
    /** The raw provider error payload, if any. */
    raw?: unknown;
}

export class AnyModelError extends Error {
    readonly provider?: string;
    readonly statusCode?: number;
    readonly raw?: unknown;
    /** Whether a retry/fallback layer should consider retrying. */
    readonly isRetryable: boolean = false;

    constructor(message: string, options: AnyModelErrorOptions = {}) {
        super(message, { cause: options.cause });
        this.name = new.target.name;
        this.provider = options.provider;
        this.statusCode = options.statusCode;
        this.raw = options.raw;
    }
}

/** Missing/invalid credentials. Not retryable. */
export class AuthError extends AnyModelError {}

/** Rate limited. Retryable; `retryAfterMs` from `Retry-After` when present. */
export class RateLimitError extends AnyModelError {
    override readonly isRetryable = true;
    readonly retryAfterMs?: number;

    constructor(message: string, options: AnyModelErrorOptions & { retryAfterMs?: number } = {}) {
        super(message, options);
        this.retryAfterMs = options.retryAfterMs;
    }
}

/** Prompt exceeded the model's context window. Not retryable as-is. */
export class ContextLengthError extends AnyModelError {}

/** Content blocked by a provider safety filter. Not retryable. */
export class ContentFilterError extends AnyModelError {}

/** A requested feature isn't supported by this model/provider. Not retryable. */
export class UnsupportedFeatureError extends AnyModelError {
    readonly feature: string;

    constructor(feature: string, options: AnyModelErrorOptions & { message?: string } = {}) {
        super(options.message ?? `Unsupported feature: ${feature}`, options);
        this.feature = feature;
    }
}

/** Catch-all for provider/transport errors. Retryable for 5xx / network. */
export class ProviderError extends AnyModelError {
    override readonly isRetryable: boolean;

    constructor(message: string, options: AnyModelErrorOptions & { isRetryable?: boolean } = {}) {
        super(message, options);
        this.isRetryable =
            options.isRetryable ?? (options.statusCode !== undefined && options.statusCode >= 500);
    }
}
