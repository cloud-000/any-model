import {
    chatGPT,
    memoryCredentialStore,
    startBrowserLogin,
    startDeviceCodeLogin,
} from "@any-model/chatgpt";
import { createRegistry } from "@any-model/core";

// Replace this in a real application with a keychain, encrypted database, or
// another caller-owned ChatGPTCredentialStore implementation.
const credentialStore = memoryCredentialStore();

if (process.env.CHATGPT_DEVICE_LOGIN === "1") {
    const login = await startDeviceCodeLogin({ credentialStore });
    console.log(`Open ${login.verificationURI} and enter ${login.userCode}`);
    await login.credentials;
} else {
    const login = await startBrowserLogin({ credentialStore });
    console.log(`If the browser did not open, visit ${login.authorizationURL}`);
    await login.credentials;
}

// The same store is reused by the provider and receives rotated refresh tokens.
const ai = createRegistry().use(chatGPT({ credentialStore }));
const model = ai.languageModel(`chatgpt:${process.env.CHATGPT_MODEL_ID ?? "gpt-5.4"}`);
const result = await model.generate({
    messages: [{ role: "user", content: "Tell me what model you are!" }],
});
console.log(result.text);

// Logging out is application-owned as well.
await credentialStore.clear();
