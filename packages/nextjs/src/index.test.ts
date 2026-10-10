import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { withSourceMaps } from "./index.js";

it("collects nested JavaScript maps and preserves the existing compile hook", async () => {
  const dir = await mkdtemp(join(tmpdir(), "next-source-maps-"));
  const entries = new Map<string, string>();
  const close = vi.fn();
  const previousHook = vi.fn(async () => {});
  try {
    await mkdir(join(dir, "nested"));
    for (const extension of ["js", "mjs", "cjs"]) {
      await writeFile(
        join(dir, "nested", `entry.${extension}.map`),
        JSON.stringify({ debugId: extension, version: 3, sources: [] }),
      );
    }
    await writeFile(join(dir, "style.css.map"), "{}");
    const config = withSourceMaps(
      { compiler: { runAfterProductionCompile: previousHook } },
      {
        store: (distDir) => {
          expect(distDir).toBe(dir);
          return {
            get: (id) => entries.get(id) ?? null,
            put: (id, content) => {
              entries.set(id, content);
            },
            close,
          };
        },
      },
    );
    const metadata = { distDir: dir, projectDir: dir };
    await config.compiler?.runAfterProductionCompile?.(metadata);
    expect([...entries.keys()].toSorted()).toEqual(["cjs", "js", "mjs"]);
    expect(close).toHaveBeenCalledOnce();
    expect(previousHook).toHaveBeenCalledWith(metadata);
    for (const extension of ["js", "mjs", "cjs"]) {
      await expect
        .poll(() => existsSync(join(dir, "nested", `entry.${extension}.map`)))
        .toBe(false);
    }
    expect(existsSync(join(dir, "style.css.map"))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
