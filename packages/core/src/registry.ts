/**
 * The registry: register providers, then resolve models by a
 * `"providerId:modelId"` string. Changing that string is the one-line switch.
 */
import type { LanguageModel, Provider } from "./provider.ts";

export class Registry {
    private readonly providers = new Map<string, Provider>();

    /** Register a provider. Later registration of the same id overrides. */
    use(provider: Provider): this {
        this.providers.set(provider.id, provider);
        return this;
    }

    /** Get a registered provider by id, or throw. */
    provider(id: string): Provider {
        const provider = this.providers.get(id);
        if (!provider) {
            throw new Error(
                `Unknown provider "${id}". Registered: ${this.providerIds().join(", ") || "(none)"}`,
            );
        }
        return provider;
    }

    /**
     * Resolve a model from a `"providerId:modelId"` id. Only the first ":" is a
     * separator, so model ids may themselves contain ":".
     */
    languageModel(id: string): LanguageModel {
        const sep = id.indexOf(":");
        if (sep <= 0 || sep === id.length - 1) {
            throw new Error(`Invalid model id "${id}". Expected "providerId:modelId".`);
        }
        const providerId = id.slice(0, sep);
        const modelId = id.slice(sep + 1);
        return this.provider(providerId).languageModel(modelId);
    }

    providerIds(): string[] {
        return [...this.providers.keys()];
    }
}

export function createRegistry(): Registry {
    return new Registry();
}
