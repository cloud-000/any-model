import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const cwd = resolve(process.cwd());
const packageDirs = cwd === root
    ? [
        "core",
        "agent",
        "openai-compat",
        "testing",
        "google",
        "chatgpt",
        "openrouter",
    ].map((name) => join(root, "packages", name))
    : [cwd];

for (const packageDir of packageDirs) {
    const packageJson = await Bun.file(join(packageDir, "package.json")).json() as {
        name?: string;
        private?: boolean;
        peerDependencies?: Record<string, string>;
    };

    if (packageJson.private) continue;

    const entrypoint = join(packageDir, "src", "index.ts");
    const dist = join(packageDir, "dist");
    // Peer dependencies must be external: bundling them would inline a second
    // copy into dist, defeating the point of resolving to the host app's install.
    const externals = [
        ...Object.keys(packageJson.peerDependencies ?? {}),
        ...(packageJson.name === "@any-model/core"
            ? []
            : ["@any-model/core", "@any-model/openai-compat"]),
    ];

    await rm(dist, { recursive: true, force: true });

    const result = await Bun.build({
        entrypoints: [entrypoint],
        outdir: dist,
        target: "node",
        format: "esm",
        naming: "index.js",
        external: externals,
        sourcemap: "external",
    });

    if (!result.success) {
        console.error(`Failed to build ${packageJson.name ?? packageDir}`);
        for (const log of result.logs) console.error(log);
        process.exitCode = 1;
        break;
    }

    const declarationResult = Bun.spawnSync([
        "bun",
        "x",
        "--no-install",
        "tsc",
        "-p",
        join(packageDir, "tsconfig.build.json"),
    ], { cwd: packageDir, stdout: "inherit", stderr: "inherit" });

    if (declarationResult.exitCode !== 0) {
        process.exitCode = declarationResult.exitCode;
        break;
    }
}
