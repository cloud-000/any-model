/**
 * The application-facing side of the tool-calling contract. `tool()` builds a
 * `ToolDefinition` (wire fields + executable `execute`); `toWireTools()` is the
 * one place that strips `execute` back off before anything reaches a provider.
 */
import type {
    JSONSchema,
    ProviderOptions,
    SchemaAdapter,
    Tool,
    ToolDefinition,
    ToolExecutionContext,
} from "./types.ts";
import { ToolInputError } from "./errors.ts";

function isSchemaAdapter<T>(value: JSONSchema | SchemaAdapter<T>): value is SchemaAdapter<T> {
    return typeof (value as SchemaAdapter<T>).parse === "function";
}

export function tool<Args = unknown, Result = unknown>(def: {
    name: string;
    description?: string;
    inputSchema: JSONSchema | SchemaAdapter<Args>;
    providerOptions?: ProviderOptions;
    execute(args: Args, ctx: ToolExecutionContext): Result | Promise<Result>;
}): ToolDefinition<Result> {
    // Normalize to one shape so execute has a single code path.
    const schema: SchemaAdapter<Args> = isSchemaAdapter(def.inputSchema)
        ? def.inputSchema
        : { jsonSchema: def.inputSchema, parse: (input) => input as Args };

    return {
        name: def.name,
        description: def.description,
        inputSchema: schema.jsonSchema,
        providerOptions: def.providerOptions,
        async execute(rawArgs, ctx) {
            let args: Args;
            try {
                args = await schema.parse(rawArgs);
            } catch (cause) {
                throw new ToolInputError(def.name, { cause });
            }
            return def.execute(args, ctx); // outside the try: user errors stay user errors
        },
    };
}

/** The one crossing point from definition to wire. Allowlist, not denylist:
 *  a new field on Tool must be added here (see tool.test.ts for the guard). */
export function toWireTools(tools: readonly (Tool | ToolDefinition)[]): Tool[] {
    return tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        providerOptions: t.providerOptions,
    }));
}
