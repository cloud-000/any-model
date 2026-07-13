/**
 * Experimental ChatGPT subscription provider.
 *
 * This package follows the Codex client flow rather than a stable public
 * OpenAI Platform API contract. Wire details may change without notice.
 */
export { chatGPT, chatGPTOptions, makeRequestBody } from "./provider.ts";
export type { ChatGPTConfig, ChatGPTOptions } from "./provider.ts";
export {
    startBrowserLogin,
    startDeviceCodeLogin,
    exchangeAuthorizationCode,
} from "./oauth.ts";
export type {
    BrowserLoginOptions,
    BrowserLoginSession,
    BrowserCallbackServer,
    BrowserCallbackServerFactory,
    DeviceCodeLoginOptions,
    DeviceCodeLoginSession,
    OpenURLFunction,
} from "./oauth.ts";
export { memoryCredentialStore } from "./credentials.ts";
export type {
    ChatGPTCredentials,
    ChatGPTCredentialStore,
} from "./credentials.ts";
export type { FetchFunction } from "./auth-manager.ts";
