import { AuthError, ProviderError } from "@any-model/core";
import { oauthErrorMessage, safeJson, type FetchFunction } from "./auth-manager.ts";
import {
    credentialsFromTokenResponse,
    type ChatGPTCredentialStore,
    type ChatGPTCredentials,
} from "./credentials.ts";
import {
    AUTHORIZE_URL,
    CHATGPT_CLIENT_ID,
    DEVICE_CALLBACK_URL,
    DEVICE_TOKEN_URL,
    DEVICE_USER_CODE_URL,
    TOKEN_URL,
    type DeviceTokenResponse,
    type DeviceUserCodeResponse,
    type OAuthTokenResponse,
} from "./wire.ts";

const DEFAULT_CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const DEFAULT_DEVICE_INTERVAL_MS = 5_000;

export type OpenURLFunction = (url: string) => void | Promise<void>;

export interface BrowserCallbackServer {
    readonly port: number;
    stop(force?: boolean): void | Promise<void>;
}

export type BrowserCallbackServerFactory = (
    handler: (request: Request) => Response | Promise<Response>,
    port: number,
) => BrowserCallbackServer;

export interface BrowserLoginOptions {
    credentialStore: ChatGPTCredentialStore;
    fetch?: FetchFunction;
    openURL?: OpenURLFunction;
    abortSignal?: AbortSignal;
    /** Primarily useful for isolated tests. The Codex-compatible default is 1455. */
    port?: number;
    /** Injectable loopback server boundary for tests and embedded runtimes. */
    callbackServerFactory?: BrowserCallbackServerFactory;
}

export interface BrowserLoginSession {
    authorizationURL: string;
    credentials: Promise<ChatGPTCredentials>;
    cancel(): Promise<void>;
}

export interface DeviceCodeLoginOptions {
    credentialStore: ChatGPTCredentialStore;
    fetch?: FetchFunction;
    abortSignal?: AbortSignal;
    /** Override the server polling interval, primarily for tests. */
    pollIntervalMs?: number;
}

export interface DeviceCodeLoginSession {
    userCode: string;
    verificationURI: string;
    expiresAt: number;
    credentials: Promise<ChatGPTCredentials>;
    cancel(): Promise<void>;
}

export async function startBrowserLogin(
    options: BrowserLoginOptions,
): Promise<BrowserLoginSession> {
    if (!options?.credentialStore) throw new TypeError("credentialStore is required.");
    if (options.abortSignal?.aborted) throw abortError();

    const fetchImpl = options.fetch ?? globalThis.fetch;
    const verifier = randomBase64URL(32);
    const challenge = await pkceChallenge(verifier);
    const state = randomBase64URL(24);
    const deferred = createDeferred<ChatGPTCredentials>();
    let settled = false;

    let server: BrowserCallbackServer;
    try {
        const handler = async (request: Request) => {
            const url = new URL(request.url);
            if (url.pathname !== CALLBACK_PATH) {
                return new Response("Not found", { status: 404 });
            }
            if (url.searchParams.get("state") !== state) {
                return htmlResponse("Sign-in failed", "The OAuth state did not match.", 400);
            }
            const error = url.searchParams.get("error");
            if (error) {
                const description = url.searchParams.get("error_description");
                fail(
                    new AuthError(description || `ChatGPT login failed (${error}).`, {
                        provider: "chatgpt",
                    }),
                );
                return htmlResponse("Sign-in failed", "Return to the application and try again.", 400);
            }
            const code = url.searchParams.get("code");
            if (!code) {
                fail(
                    new AuthError("ChatGPT callback did not include an authorization code.", {
                        provider: "chatgpt",
                    }),
                );
                return htmlResponse("Sign-in failed", "The authorization code was missing.", 400);
            }
            try {
                const credentials = await exchangeAuthorizationCode({
                    code,
                    verifier,
                    redirectURI,
                    fetch: fetchImpl,
                });
                await saveCredentials(options.credentialStore, credentials);
                succeed(credentials);
                return htmlResponse(
                    "Sign-in complete",
                    "You can close this window and return to the application.",
                );
            } catch (error) {
                fail(error);
                return htmlResponse(
                    "Sign-in failed",
                    "Return to the application and try again.",
                    400,
                );
            }
        };
        server = (options.callbackServerFactory ?? defaultCallbackServerFactory)(
            handler,
            options.port ?? DEFAULT_CALLBACK_PORT,
        );
    } catch (cause) {
        throw new ProviderError("Could not start the ChatGPT OAuth callback server.", {
            provider: "chatgpt",
            cause,
        });
    }

    const redirectURI = `http://localhost:${server.port}${CALLBACK_PATH}`;
    const authorizationURL = makeAuthorizationURL({ redirectURI, challenge, state });

    const stop = async () => {
        options.abortSignal?.removeEventListener("abort", onAbort);
        await server.stop(true);
    };
    const succeed = (credentials: ChatGPTCredentials) => {
        if (settled) return;
        settled = true;
        deferred.resolve(credentials);
        queueMicrotask(() => void stop());
    };
    const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        deferred.reject(error);
        queueMicrotask(() => void stop());
    };
    const onAbort = () => fail(abortError());
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });

    try {
        await (options.openURL ?? openSystemBrowser)(authorizationURL);
    } catch (cause) {
        const error = new ProviderError("Could not open the ChatGPT authorization URL.", {
            provider: "chatgpt",
            cause,
        });
        // The session is not returned, so prevent its internal promise from
        // becoming an unhandled rejection.
        void deferred.promise.catch(() => undefined);
        fail(error);
        await stop();
        throw error;
    }

    return {
        authorizationURL,
        credentials: deferred.promise,
        async cancel() {
            fail(abortError());
            await stop();
        },
    };
}

export async function startDeviceCodeLogin(
    options: DeviceCodeLoginOptions,
): Promise<DeviceCodeLoginSession> {
    if (!options?.credentialStore) throw new TypeError("credentialStore is required.");
    if (options.abortSignal?.aborted) throw abortError();
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });

    let response: Response;
    try {
        response = await fetchImpl(DEVICE_USER_CODE_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID }),
            signal: controller.signal,
        });
    } catch (cause) {
        options.abortSignal?.removeEventListener("abort", onAbort);
        if (controller.signal.aborted) throw abortError();
        throw new ProviderError("ChatGPT device-code request failed.", {
            provider: "chatgpt",
            cause,
            isRetryable: true,
        });
    }
    const payload = (await safeJson(response)) as DeviceUserCodeResponse;
    if (!response.ok) {
        options.abortSignal?.removeEventListener("abort", onAbort);
        throw new AuthError(oauthErrorMessage(payload, "ChatGPT device-code login is unavailable."), {
            provider: "chatgpt",
            statusCode: response.status,
        });
    }
    const deviceAuthId = payload.device_auth_id ?? payload.device_code;
    const userCode = payload.user_code;
    const verificationURI =
        payload.verification_uri_complete ?? payload.verification_uri ?? payload.verification_url;
    if (!deviceAuthId || !userCode || !verificationURI) {
        options.abortSignal?.removeEventListener("abort", onAbort);
        throw new AuthError("ChatGPT device-code response was incomplete.", {
            provider: "chatgpt",
        });
    }
    const expiresAt = Date.now() + (payload.expires_in ?? 900) * 1_000;
    const initialInterval =
        options.pollIntervalMs ?? Math.max(0, (payload.interval ?? 5) * 1_000);

    const credentials = pollDeviceCredentials({
        deviceAuthId,
        userCode,
        expiresAt,
        intervalMs: initialInterval,
        fetch: fetchImpl,
        store: options.credentialStore,
        signal: controller.signal,
    }).finally(() => options.abortSignal?.removeEventListener("abort", onAbort));

    return {
        userCode,
        verificationURI,
        expiresAt,
        credentials,
        async cancel() {
            controller.abort();
            await credentials.catch(() => undefined);
        },
    };
}

export async function exchangeAuthorizationCode(input: {
    code: string;
    verifier: string;
    redirectURI: string;
    fetch?: FetchFunction;
}): Promise<ChatGPTCredentials> {
    const fetchImpl = input.fetch ?? globalThis.fetch;
    let response: Response;
    try {
        response = await fetchImpl(TOKEN_URL, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                client_id: CHATGPT_CLIENT_ID,
                code: input.code,
                code_verifier: input.verifier,
                redirect_uri: input.redirectURI,
            }),
        });
    } catch (cause) {
        throw new ProviderError("ChatGPT token exchange request failed.", {
            provider: "chatgpt",
            cause,
            isRetryable: true,
        });
    }
    const payload = await safeJson(response);
    if (!response.ok) {
        throw new AuthError(oauthErrorMessage(payload, "ChatGPT token exchange failed."), {
            provider: "chatgpt",
            statusCode: response.status,
        });
    }
    return credentialsFromTokenResponse(payload as OAuthTokenResponse);
}

async function pollDeviceCredentials(input: {
    deviceAuthId: string;
    userCode: string;
    expiresAt: number;
    intervalMs: number;
    fetch: FetchFunction;
    store: ChatGPTCredentialStore;
    signal: AbortSignal;
}): Promise<ChatGPTCredentials> {
    let intervalMs = input.intervalMs || DEFAULT_DEVICE_INTERVAL_MS;
    while (Date.now() < input.expiresAt) {
        await abortableDelay(intervalMs, input.signal);
        let response: Response;
        try {
            response = await input.fetch(DEVICE_TOKEN_URL, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    device_auth_id: input.deviceAuthId,
                    user_code: input.userCode,
                }),
                signal: input.signal,
            });
        } catch (cause) {
            if (input.signal.aborted) throw abortError();
            throw new ProviderError("ChatGPT device-code polling request failed.", {
                provider: "chatgpt",
                cause,
                isRetryable: true,
            });
        }
        const payload = (await safeJson(response)) as DeviceTokenResponse;
        if (response.ok) {
            let credentials: ChatGPTCredentials;
            if (payload.access_token) {
                credentials = credentialsFromTokenResponse(payload);
            } else {
                const code = payload.authorization_code ?? payload.code;
                const verifier = payload.code_verifier;
                if (!code || !verifier) {
                    throw new AuthError("ChatGPT device-code token response was incomplete.", {
                        provider: "chatgpt",
                    });
                }
                credentials = await exchangeAuthorizationCode({
                    code,
                    verifier,
                    redirectURI: DEVICE_CALLBACK_URL,
                    fetch: input.fetch,
                });
            }
            await saveCredentials(input.store, credentials);
            return credentials;
        }
        if (payload.error === "authorization_pending") continue;
        if (payload.error === "slow_down") {
            intervalMs += 5_000;
            continue;
        }
        if (payload.error === "access_denied") {
            throw new AuthError("ChatGPT device-code login was denied.", { provider: "chatgpt" });
        }
        if (payload.error === "expired_token") break;
        throw new AuthError(oauthErrorMessage(payload, "ChatGPT device-code login failed."), {
            provider: "chatgpt",
            statusCode: response.status,
        });
    }
    throw new AuthError("ChatGPT device code expired before authorization completed.", {
        provider: "chatgpt",
    });
}

function makeAuthorizationURL(input: {
    redirectURI: string;
    challenge: string;
    state: string;
}): string {
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
        response_type: "code",
        client_id: CHATGPT_CLIENT_ID,
        redirect_uri: input.redirectURI,
        scope: "openid profile email offline_access",
        code_challenge: input.challenge,
        code_challenge_method: "S256",
        state: input.state,
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: "any-model",
    }).toString();
    return url.toString();
}

async function pkceChallenge(verifier: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return bytesToBase64URL(new Uint8Array(digest));
}

function randomBase64URL(length: number): string {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytesToBase64URL(bytes);
}

function bytesToBase64URL(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function saveCredentials(
    store: ChatGPTCredentialStore,
    credentials: ChatGPTCredentials,
): Promise<void> {
    try {
        await store.save(credentials);
    } catch (cause) {
        throw new ProviderError("Could not persist ChatGPT credentials.", {
            provider: "chatgpt",
            cause,
        });
    }
}

async function openSystemBrowser(url: string): Promise<void> {
    const command =
        process.platform === "darwin"
            ? ["open", url]
            : process.platform === "win32"
              ? ["cmd", "/c", "start", "", url]
              : ["xdg-open", url];
    const processHandle = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
    processHandle.unref();
}

function defaultCallbackServerFactory(
    handler: (request: Request) => Response | Promise<Response>,
    port: number,
): BrowserCallbackServer {
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: handler,
    });
    return {
        port: server.port ?? port,
        stop: (force) => server.stop(force),
    };
}

function htmlResponse(title: string, message: string, status = 200): Response {
    const body = `<!doctype html><meta charset="utf-8"><title>${title}</title><main><h1>${title}</h1><p>${message}</p></main>`;
    return new Response(body, {
        status,
        headers: { "content-type": "text/html; charset=utf-8" },
    });
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(done, ms);
        const onAbort = () => {
            clearTimeout(timeout);
            signal.removeEventListener("abort", onAbort);
            reject(abortError());
        };
        function done() {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

function abortError(): DOMException {
    return new DOMException("The operation was aborted.", "AbortError");
}

function createDeferred<T>(): {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(reason: unknown): void;
} {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}
