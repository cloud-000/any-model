import { AuthError, ProviderError } from "@any-model/core";
import {
    credentialsFromTokenResponse,
    type ChatGPTCredentialStore,
    type ChatGPTCredentials,
} from "./credentials.ts";
import {
    CHATGPT_CLIENT_ID,
    TOKEN_URL,
    type OAuthTokenResponse,
} from "./wire.ts";

export type FetchFunction = (
    input: string | URL | Request,
    init?: RequestInit,
) => Promise<Response>;

const REFRESH_SKEW_MS = 60_000;

export class ChatGPTAuthManager {
    private cached: ChatGPTCredentials | undefined;
    private loaded = false;
    private refreshPromise: Promise<ChatGPTCredentials> | undefined;

    constructor(
        private readonly store: ChatGPTCredentialStore,
        private readonly fetchImpl: FetchFunction = globalThis.fetch,
        private readonly now: () => number = Date.now,
    ) {}

    async getCredentials(): Promise<ChatGPTCredentials> {
        const credentials = await this.load();
        if (credentials.expiresAt - this.now() <= REFRESH_SKEW_MS) return this.refresh();
        return credentials;
    }

    async refreshAfterUnauthorized(staleAccessToken: string): Promise<ChatGPTCredentials> {
        const current = await this.load();
        if (current.accessToken !== staleAccessToken) return current;
        return this.refresh();
    }

    async clear(): Promise<void> {
        this.cached = undefined;
        this.loaded = true;
        await this.store.clear();
    }

    private async load(): Promise<ChatGPTCredentials> {
        if (!this.loaded) {
            this.cached = await this.store.load();
            this.loaded = true;
        }
        if (!this.cached) {
            throw new AuthError("No ChatGPT credentials are available. Sign in first.", {
                provider: "chatgpt",
            });
        }
        return this.cached;
    }

    private refresh(): Promise<ChatGPTCredentials> {
        if (this.refreshPromise) return this.refreshPromise;
        this.refreshPromise = this.performRefresh().finally(() => {
            this.refreshPromise = undefined;
        });
        return this.refreshPromise;
    }

    private async performRefresh(): Promise<ChatGPTCredentials> {
        const previous = await this.load();
        let response: Response;
        try {
            response = await this.fetchImpl(TOKEN_URL, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_id: CHATGPT_CLIENT_ID,
                    grant_type: "refresh_token",
                    refresh_token: previous.refreshToken,
                }),
            });
        } catch (cause) {
            throw new ProviderError("ChatGPT token refresh request failed.", {
                provider: "chatgpt",
                cause,
                isRetryable: true,
            });
        }
        const payload = await safeJson(response);
        if (!response.ok) {
            throw new AuthError(oauthErrorMessage(payload, "ChatGPT token refresh failed."), {
                provider: "chatgpt",
                statusCode: response.status,
            });
        }
        const credentials = credentialsFromTokenResponse(
            payload as OAuthTokenResponse,
            previous.refreshToken,
            this.now(),
        );
        try {
            await this.store.save(credentials);
        } catch (cause) {
            throw new ProviderError("Could not persist refreshed ChatGPT credentials.", {
                provider: "chatgpt",
                cause,
            });
        }
        this.cached = credentials;
        return credentials;
    }
}

export async function safeJson(response: Response): Promise<Record<string, unknown>> {
    try {
        const value: unknown = await response.json();
        return typeof value === "object" && value !== null
            ? (value as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

export function oauthErrorMessage(
    payload: Record<string, unknown>,
    fallback: string,
): string {
    const description = payload.error_description;
    if (typeof description === "string" && description !== "") return description;
    const error = payload.error;
    if (typeof error === "string" && error !== "") return `${fallback} (${error})`;
    return fallback;
}
