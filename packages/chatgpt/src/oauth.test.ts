import { describe, expect, test } from "bun:test";
import { ProviderError } from "@any-model/core";
import { memoryCredentialStore } from "./credentials.ts";
import { startBrowserLogin, startDeviceCodeLogin } from "./oauth.ts";
import {
    DEVICE_CALLBACK_URL,
    DEVICE_TOKEN_URL,
    DEVICE_USER_CODE_URL,
    TOKEN_URL,
} from "./wire.ts";
import { jwt } from "./test-utils.ts";

describe("ChatGPT OAuth", () => {
    test("browser login validates state, exchanges PKCE code, saves, and closes", async () => {
        const store = memoryCredentialStore();
        let opened = "";
        let tokenBody = "";
        const callback = fakeCallbackServer();
        const session = await startBrowserLogin({
            credentialStore: store,
            callbackServerFactory: callback.factory,
            openURL: (url) => {
                opened = url;
            },
            fetch: async (url, init) => {
                expect(String(url)).toBe(TOKEN_URL);
                tokenBody = String(init?.body);
                return Response.json({
                    access_token: jwt({ chatgpt_account_id: "acct", exp: 9999999999 }),
                    refresh_token: "refresh",
                    expires_in: 3600,
                });
            },
        });
        const authURL = new URL(opened);
        expect(authURL.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authURL.searchParams.get("code_challenge")).toBeTruthy();
        const callbackURL = new URL(authURL.searchParams.get("redirect_uri")!);
        callbackURL.searchParams.set("state", authURL.searchParams.get("state")!);
        callbackURL.searchParams.set("code", "authorization-code");
        expect((await callback.dispatch(callbackURL)).status).toBe(200);
        const credentials = await session.credentials;
        expect(credentials.accountId).toBe("acct");
        expect((await store.load())?.refreshToken).toBe("refresh");
        expect(tokenBody).toContain("code_verifier=");
        expect(tokenBody).toContain("code=authorization-code");
    });

    test("wrong browser state is rejected without consuming the real session", async () => {
        let opened = "";
        const callback = fakeCallbackServer();
        const session = await startBrowserLogin({
            credentialStore: memoryCredentialStore(),
            callbackServerFactory: callback.factory,
            openURL: (url) => {
                opened = url;
            },
            fetch: async () => {
                throw new Error("token exchange should not run");
            },
        });
        const authURL = new URL(opened);
        const callbackURL = new URL(authURL.searchParams.get("redirect_uri")!);
        callbackURL.searchParams.set("state", "wrong");
        callbackURL.searchParams.set("code", "code");
        expect((await callback.dispatch(callbackURL)).status).toBe(400);
        const credentials = session.credentials;
        await session.cancel();
        await expect(credentials).rejects.toMatchObject({ name: "AbortError" });
    });

    test("browser-launch failure closes the callback server", async () => {
        await expect(
            startBrowserLogin({
                credentialStore: memoryCredentialStore(),
                callbackServerFactory: fakeCallbackServer().factory,
                openURL: () => {
                    throw new Error("no browser");
                },
            }),
        ).rejects.toBeInstanceOf(ProviderError);
    });

    test("callback-server startup failure is normalized", async () => {
        await expect(
            startBrowserLogin({
                credentialStore: memoryCredentialStore(),
                callbackServerFactory: () => {
                    throw new Error("address already in use");
                },
                openURL() {},
            }),
        ).rejects.toBeInstanceOf(ProviderError);
    });

    test("OAuth callback errors reject the browser session", async () => {
        let opened = "";
        const callback = fakeCallbackServer();
        const session = await startBrowserLogin({
            credentialStore: memoryCredentialStore(),
            callbackServerFactory: callback.factory,
            openURL: (url) => {
                opened = url;
            },
        });
        const authURL = new URL(opened);
        const callbackURL = new URL(authURL.searchParams.get("redirect_uri")!);
        callbackURL.searchParams.set("state", authURL.searchParams.get("state")!);
        callbackURL.searchParams.set("error", "access_denied");
        callbackURL.searchParams.set("error_description", "Login denied");
        const credentials = session.credentials;
        expect((await callback.dispatch(callbackURL)).status).toBe(400);
        await expect(credentials).rejects.toThrow("Login denied");
    });

    test("device login handles pending state then saves direct tokens", async () => {
        const store = memoryCredentialStore();
        let polls = 0;
        const session = await startDeviceCodeLogin({
            credentialStore: store,
            pollIntervalMs: 1,
            fetch: async (url) => {
                if (String(url) === DEVICE_USER_CODE_URL) {
                    return Response.json({
                        device_auth_id: "device",
                        user_code: "ABCD-EFGH",
                        verification_uri: "https://auth.openai.com/device",
                        expires_in: 60,
                        interval: 1,
                    });
                }
                expect(String(url)).toBe(DEVICE_TOKEN_URL);
                polls++;
                if (polls === 1) {
                    return Response.json({ error: "authorization_pending" }, { status: 400 });
                }
                return Response.json({
                    access_token: jwt({ chatgpt_account_id: "acct", exp: 9999999999 }),
                    refresh_token: "refresh",
                    expires_in: 3600,
                });
            },
        });
        expect(session.userCode).toBe("ABCD-EFGH");
        expect(session.verificationURI).toContain("/device");
        expect((await session.credentials).accountId).toBe("acct");
        expect((await store.load())?.accessToken).toBeTruthy();
    });

    test("device login can be cancelled", async () => {
        const session = await startDeviceCodeLogin({
            credentialStore: memoryCredentialStore(),
            pollIntervalMs: 1_000,
            fetch: async (url) => {
                if (String(url) === DEVICE_USER_CODE_URL) {
                    return Response.json({
                        device_auth_id: "device",
                        user_code: "CODE",
                        verification_uri: "https://auth.openai.com/device",
                        expires_in: 60,
                    });
                }
                throw new Error("poll should be cancelled first");
            },
        });
        const credentials = session.credentials;
        await session.cancel();
        await expect(credentials).rejects.toMatchObject({ name: "AbortError" });
    });

    test("device authorization-code result uses the Codex callback URI", async () => {
        let exchangeBody = "";
        const session = await startDeviceCodeLogin({
            credentialStore: memoryCredentialStore(),
            pollIntervalMs: 1,
            fetch: async (url, init) => {
                if (String(url) === DEVICE_USER_CODE_URL) {
                    return Response.json({
                        device_auth_id: "device",
                        user_code: "CODE",
                        verification_uri: "https://auth.openai.com/device",
                        expires_in: 60,
                    });
                }
                if (String(url) === DEVICE_TOKEN_URL) {
                    return Response.json({
                        authorization_code: "authorization-code",
                        code_verifier: "verifier",
                    });
                }
                expect(String(url)).toBe(TOKEN_URL);
                exchangeBody = String(init?.body);
                return Response.json({
                    access_token: jwt({ chatgpt_account_id: "acct", exp: 9999999999 }),
                    refresh_token: "refresh",
                    expires_in: 3600,
                });
            },
        });
        await session.credentials;
        expect(exchangeBody).toContain(`redirect_uri=${encodeURIComponent(DEVICE_CALLBACK_URL)}`);
    });
});

function fakeCallbackServer() {
    let handler: ((request: Request) => Response | Promise<Response>) | undefined;
    return {
        factory(nextHandler: (request: Request) => Response | Promise<Response>) {
            handler = nextHandler;
            return { port: 43145, stop() {} };
        },
        dispatch(url: URL) {
            if (!handler) throw new Error("callback server was not started");
            return handler(new Request(url.toString()));
        },
    };
}
