/**
 * The application-facing side of the tool-calling contract. `tool()` builds a
 * `ToolDefinition` (wire fields + executable `execute`); `toWireTools()` is the
 * one place that strips `execute` back off before anything reaches a provider.
 *
 * `inputSchema` accepts three shapes, in dispatch order:
 *
 *   1. A Standard Schema (`z.object(...)`, `v.object(...)`, an ArkType type) —
 *      the normal path. One declaration yields the argument type, the runtime
 *      validation, and the JSON Schema sent on the wire.
 *   2. A `SchemaAdapter` — explicit `{ jsonSchema, parse }` for hand-written
 *      schemas or libraries this can't convert.
 *   3. A bare `JSONSchema` — no validation, `execute` receives `unknown`.
 */
import { toJSONSchema } from "zod";
import type {
    JSONSchema,
    ProviderOptions,
    SchemaAdapter,
    StandardSchemaV1,
    Tool,
    ToolDefinition,
    ToolExecutionContext,
} from "./types.ts";
import { ToolInputError, UnsupportedFeatureError } from "./errors.ts";

/** Everything `tool()` accepts for `inputSchema`. */
export type ToolInputSchema<Args = unknown> =
    | StandardSchemaV1<unknown, Args>
    | SchemaAdapter<Args>
    | JSONSchema;

/**
 * The type `execute` receives, derived from whichever shape was passed. A bare
 * JSON Schema carries no type information, so it degrades to `unknown`.
 *
 * The Standard Schema branch reads the `types` phantom by indexed access rather
 * than `infer`: `Output` appears at several positions in the interface, and
 * inferring across all of them collapses to `unknown`.
 */
export type InferToolArgs<S> = S extends StandardSchemaV1
    ? NonNullable<S["~standard"]["types"]>["output"]
    : S extends SchemaAdapter<infer Args> ? Args
    : unknown;

function isStandardSchema(value: unknown): value is StandardSchemaV1 {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
    if (!("~standard" in value)) return false;
    const std = (value as StandardSchemaV1)["~standard"];
    return typeof std === "object" && std !== null && std.version === 1 &&
        typeof std.validate === "function";
}

/**
 * Checks for `jsonSchema` as well as `parse`, because schema libraries expose a
 * `parse` of their own — a Zod schema would otherwise be mistaken for an adapter
 * and end up with an `undefined` wire schema.
 */
function isSchemaAdapter<T>(value: ToolInputSchema<T>): value is SchemaAdapter<T> {
    const candidate = value as Partial<SchemaAdapter<T>>;
    return typeof candidate.parse === "function" && typeof candidate.jsonSchema === "object" &&
        candidate.jsonSchema !== null;
}

/**
 * Converts a Standard Schema to JSON Schema. Prefers the schema's own converter
 * (the spec's proposed `jsonSchema` extension) so any library implementing it
 * works without being named here; Zod is special-cased because it doesn't.
 */
function standardToJSONSchema(schema: StandardSchemaV1, toolName: string): JSONSchema {
    const std = schema["~standard"];

    if (typeof std.jsonSchema?.input === "function") {
        return std.jsonSchema.input();
    }

    if (std.vendor === "zod") {
        // `io: "input"` because tool arguments are what the model must send —
        // with defaults or transforms the input and output shapes differ.
        // `unrepresentable: "any"` degrades types that have no JSON Schema form
        // (z.date(), z.bigint()) rather than throwing.
        // `as never` selects zod's schema overload without deep-importing its
        // internal $ZodType; `Parameters<typeof toJSONSchema>[0]` resolves to
        // the registry overload instead.
        return toJSONSchema(schema as never, {
            io: "input",
            unrepresentable: "any",
        }) as JSONSchema;
    }

    throw new UnsupportedFeatureError("json-schema-conversion", {
        message: `Cannot derive a JSON Schema for tool "${toolName}" from schema vendor ` +
            `"${std.vendor}": it does not implement the Standard Schema jsonSchema ` +
            `extension. Pass a SchemaAdapter ({ jsonSchema, parse }) instead.`,
    });
}

/** Normalizes any accepted shape into the one `{ jsonSchema, parse }` pair execute needs. */
function toAdapter<Args>(inputSchema: ToolInputSchema<Args>, toolName: string): SchemaAdapter<Args> {
    if (isStandardSchema(inputSchema)) {
        const schema = inputSchema as StandardSchemaV1<unknown, Args>;
        return {
            jsonSchema: standardToJSONSchema(schema, toolName),
            // Standard Schema reports failure by *returning* `issues`, it does
            // not throw — without this check invalid args would reach execute as
            // `undefined`. tool() turns the throw into a ToolInputError.
            parse: async (input) => {
                const result = await schema["~standard"].validate(input);
                if (result.issues) {
                    throw new Error(result.issues.map((issue) => issue.message).join("; "));
                }
                return result.value;
            },
        };
    }

    if (isSchemaAdapter(inputSchema)) return inputSchema;

    return { jsonSchema: inputSchema as JSONSchema, parse: (input) => input as Args };
}

// `any` is the constraint that lets all three member shapes match; InferToolArgs
// recovers the precise type from S, so nothing downstream is loosened by it.
// deno-lint-ignore no-explicit-any
export function tool<S extends ToolInputSchema<any>, Result = unknown>(def: {
    name: string;
    description?: string;
    inputSchema: S;
    providerOptions?: ProviderOptions;
    execute(args: InferToolArgs<S>, ctx: ToolExecutionContext): Result | Promise<Result>;
}): ToolDefinition<Result> {
    // Normalize to one shape so execute has a single code path.
    const schema = toAdapter<InferToolArgs<S>>(
        def.inputSchema as ToolInputSchema<InferToolArgs<S>>,
        def.name,
    );

    return {
        name: def.name,
        description: def.description,
        inputSchema: schema.jsonSchema,
        providerOptions: def.providerOptions,
        async execute(rawArgs, ctx) {
            let args: InferToolArgs<S>;
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
