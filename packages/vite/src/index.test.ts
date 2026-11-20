import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { SourceMapStore } from "smapped-traces/store";
import type { Plugin, ResolvedConfig } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectSourceMaps, sourceMaps } from "./index.js";

let tmpDir: string;
let entries: Map<string, string>;
let closed: number;
let store: SourceMapStore;

const writeMap = async (relative: string, map: object): Promise<void> => {
  const path = join(tmpDir, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(map));
};

// Vite types the plugin hooks as unions that need a plugin context. The plugin does not use `this`.
function isConfigResolvedHook(value: unknown): value is (config: ResolvedConfig) => void {
  return typeof value === "function";
}

function isConfigHook(
  value: unknown,
): value is (config: unknown, env: { readonly command: string; readonly mode: string }) => unknown {
  return typeof value === "function";
}

function isCloseBundleHook(value: unknown): value is {
  readonly order: string;
  readonly sequential: boolean;
  readonly handler: () => Promise<void>;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "order" in value &&
    "sequential" in value &&
    "handler" in value &&
    typeof value.handler === "function"
  );
}

// The tests give the plugin only the fields of the resolved configuration that it reads.
function isResolvedConfig(value: object): value is ResolvedConfig {
  return "build" in value && "logger" in value && "plugins" in value && "root" in value;
}

const remainingFiles = async (): Promise<string[]> => {
  const files = await readdir(tmpDir, { recursive: true });
  return files.filter((file) => file.endsWith(".map")).toSorted();
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "collect-test-"));
  entries = new Map();
  closed = 0;
  store = {
    close: () => {
      closed += 1;
    },
    get: (debugId) => entries.get(debugId) ?? null,
    put: (debugId, content) => {
      entries.set(debugId, content);
    },
  };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("sourceMaps plugin", () => {
  const resolveConfig = (
    plugin: Plugin,
    config: {
      readonly outDir?: string;
      readonly plugins?: readonly { readonly name: string }[];
      readonly ssr?: boolean;
    } = {},
  ): string[] => {
    const logs: string[] = [];
    const resolved = {
      build: { outDir: config.outDir ?? "dist", ssr: config.ssr ?? false },
      logger: {
        info: (message: string) => {
          logs.push(message);
        },
      },
      plugins: config.plugins ?? [],
      root: tmpDir,
    };
    const hook: unknown = plugin.configResolved;
    if (!isConfigResolvedHook(hook) || !isResolvedConfig(resolved)) {
      throw new TypeError("The plugin has no configResolved hook");
    }
    hook(resolved);
    return logs;
  };

  const closeBundle = async (plugin: Plugin): Promise<void> => {
    const hook: unknown = plugin.closeBundle;
    if (!isCloseBundleHook(hook)) {
      throw new TypeError("The plugin has no closeBundle hook");
    }
    expect(hook.order).toBe("post");
    expect(hook.sequential).toBe(true);
    await hook.handler();
  };

  it("applies to builds only", () => {
    expect(sourceMaps().apply).toBe("build");
  });

  it("configures hidden source maps with debug IDs", () => {
    const plugin = sourceMaps();
    expect(typeof plugin.config).toBe("function");
    const hook: unknown = plugin.config;
    if (!isConfigHook(hook)) {
      throw new TypeError("The plugin has no config hook");
    }
    const config = hook({}, { command: "build", mode: "production" });
    expect(config).toEqual({
      build: {
        sourcemap: "hidden",
        rolldownOptions: {
          output: {
            sourcemapDebugIds: true,
          },
        },
      },
    });
  });

  it("does not collect without the collect option", async () => {
    await writeMap("dist/entry.js.map", { debugId: "id" });

    const plugin = sourceMaps();
    resolveConfig(plugin);
    await closeBundle(plugin);

    expect(await remainingFiles()).toEqual(["dist/entry.js.map"]);
  });

  it("collects from the resolved outDir and logs the sweep", async () => {
    await writeMap("dist/entry.js.map", { debugId: "id" });

    const plugin = sourceMaps({ collect: { store: () => store } });
    const logs = resolveConfig(plugin);
    await closeBundle(plugin);

    expect([...entries.keys()]).toEqual(["id"]);
    expect(await remainingFiles()).toEqual([]);
    expect(logs).toEqual(["smapped-traces: stored 1 source maps, deleted 1 map files"]);
  });

  it("resolves a relative collect dir against the project root", async () => {
    await writeMap("build/client/entry.js.map", { debugId: "client-id" });
    await writeMap("build/server/index.js.map", { version: 3 });

    const plugin = sourceMaps({
      collect: {
        dir: "build",
        include: "client/**/*.{,c,m}js.map",
        store: (dir) => {
          expect(dir).toBe(join(tmpDir, "build"));
          return store;
        },
      },
    });
    resolveConfig(plugin);
    await closeBundle(plugin);

    expect([...entries.keys()]).toEqual(["client-id"]);
    expect(await remainingFiles()).toEqual([]);
  });

  it("skips the SvelteKit client compile pass and collects on the server pass", async () => {
    await writeMap("build/client/entry.js.map", { debugId: "client-id" });

    const collect = {
      dir: "build",
      store: () => store,
    };
    const sveltekit = [{ name: "vite-plugin-sveltekit-compile" }];

    const client = sourceMaps({ collect });
    resolveConfig(client, { plugins: sveltekit, ssr: false });
    await closeBundle(client);
    expect(await remainingFiles()).toEqual(["build/client/entry.js.map"]);

    const server = sourceMaps({ collect });
    resolveConfig(server, { plugins: sveltekit, ssr: true });
    await closeBundle(server);
    expect([...entries.keys()]).toEqual(["client-id"]);
    expect(await remainingFiles()).toEqual([]);
  });
});

describe("collectSourceMaps", () => {
  it("stores debug-ID-keyed maps and deletes every map file", async () => {
    await writeMap("client/entry.js.map", { debugId: "id-js", version: 3 });
    await writeMap("client/chunk.mjs.map", { debugId: "id-mjs", version: 3 });
    await writeMap("client/legacy.cjs.map", { debugId: "id-cjs", version: 3 });
    await writeMap("client/style.css.map", { version: 3 });

    const result = await collectSourceMaps({
      dir: tmpDir,
      store: () => store,
    });

    expect(result).toEqual({ deleted: 4, stored: 3 });
    expect([...entries.keys()].toSorted()).toEqual(["id-cjs", "id-js", "id-mjs"]);
    expect(JSON.parse(entries.get("id-js") ?? "")).toEqual({
      debugId: "id-js",
      version: 3,
    });
    expect(await remainingFiles()).toEqual([]);
    expect(closed).toBe(1);
  });

  it("restricts storage to included maps while deleting the rest", async () => {
    await writeMap("client/entry.js.map", { debugId: "client-id" });
    await writeMap("server/index.js.map", { version: 3 });

    const result = await collectSourceMaps({
      dir: tmpDir,
      include: "client/**/*.{,c,m}js.map",
      store: () => store,
    });

    expect(result).toEqual({ deleted: 2, stored: 1 });
    expect([...entries.keys()]).toEqual(["client-id"]);
    expect(await remainingFiles()).toEqual([]);
  });

  it("sweeps dot directories", async () => {
    await writeMap("client/.well-known/entry.js.map", { debugId: "dot-id" });

    const result = await collectSourceMaps({
      dir: tmpDir,
      store: () => store,
    });

    expect(result).toEqual({ deleted: 1, stored: 1 });
    expect([...entries.keys()]).toEqual(["dot-id"]);
    expect(await remainingFiles()).toEqual([]);
  });

  it("rejects included maps without a debug ID after sweeping", async () => {
    await writeMap("client/entry.js.map", { debugId: "good-id" });
    await writeMap("client/broken.js.map", { version: 3 });
    await writeMap("client/empty.js.map", { debugId: "" });

    await expect(
      collectSourceMaps({
        dir: tmpDir,
        store: () => store,
      }),
    ).rejects.toThrow(
      "source maps missing debugId (sourceMaps plugin not applied?):\n  client/broken.js.map\n  client/empty.js.map",
    );

    expect([...entries.keys()]).toEqual(["good-id"]);
    expect(await remainingFiles()).toEqual([]);
    expect(closed).toBe(1);
  });

  it("closes the store when reading a map fails", async () => {
    await writeMap("client/entry.js.map", { debugId: "id" });
    await writeFile(join(tmpDir, "client/invalid.js.map"), "not json");

    await expect(
      collectSourceMaps({
        dir: tmpDir,
        store: () => store,
      }),
    ).rejects.toThrow(SyntaxError);

    expect([...entries.keys()]).toEqual(["id"]);
    expect(closed).toBe(1);
  });

  it("supports asynchronous store factories", async () => {
    await writeMap("entry.js.map", { debugId: "async-id" });

    const result = await collectSourceMaps({
      dir: tmpDir,
      store: () => Promise.resolve(store),
    });

    expect(result).toEqual({ deleted: 1, stored: 1 });
    expect([...entries.keys()]).toEqual(["async-id"]);
  });
});
