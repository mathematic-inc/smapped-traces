import type { NextConfig } from "next";
import type { SourceMapStore } from "smapped-traces/store";
import type { RawIndexMap, RawSourceMap } from "source-map";

/**
 * Options for source map configuration.
 */
export interface SourceMapOptions {
  /**
   * URL prefix to replace the Turbopack source prefix in source maps.
   *
   * When set, paths with the `turbopack:///[project]/` prefix are transformed
   * at build time. The value must be a valid URL that will replace the
   * Turbopack prefix.
   *
   * For example, if the source map contains `turbopack:///[project]/src/app.ts`:
   * - `"file:///"` results in `file:///src/app.ts`
   * - `"app:///"` results in `app:///src/app.ts`
   */
  readonly replaceTurbopackSourcePrefix?: `${string}://${string}` | "";
  /**
   * Factory that creates a source map store. Called during the post-build hook
   * with the build output directory so the store can be placed relative to it.
   *
   * @param distDir The Next.js build output directory (e.g. ".next").
   *
   * @example
   * ```ts
   * // Local SQLite
   * store: (distDir) => createSqliteStore(join(distDir, "sourcemaps.db"))
   *
   * // Remote
   * store: () => createHttpStore("https://sourcemaps.internal")
   *
   * // S3
   * store: () => createS3Store({ client, bucket: "my-sourcemaps" })
   * ```
   */
  readonly store: (distDir: string) => SourceMapStore | Promise<SourceMapStore>;
}

const TURBOPACK_PROJECT_PREFIX = "turbopack:///[project]/";

type CompileArgs = Readonly<
  Parameters<NonNullable<NonNullable<NextConfig["compiler"]>["runAfterProductionCompile"]>>[0]
>;

/**
 * Source map with debug ID extension.
 */
type SourceMapWithDebugId = (RawSourceMap | RawIndexMap) & { readonly debugId: string };

/**
 * Returns the source paths without the Turbopack prefix, resolved against the replacement prefix.
 */
function transformSources(
  sources: readonly string[],
  replaceTurbopackSourcePrefix: string,
): string[] {
  return sources.map((source) => {
    const transformed = source.startsWith(TURBOPACK_PROJECT_PREFIX)
      ? source.slice(TURBOPACK_PROJECT_PREFIX.length)
      : source;
    return replaceTurbopackSourcePrefix === ""
      ? transformed
      : new URL(transformed, replaceTurbopackSourcePrefix).href;
  });
}

/**
 * Returns a copy of the source map with the Turbopack prefixes replaced.
 */
function transformSourceMapPaths(
  sourceMap: SourceMapWithDebugId,
  replaceTurbopackSourcePrefix: string,
): SourceMapWithDebugId {
  return {
    ...sourceMap,
    ...("sources" in sourceMap && {
      sources: transformSources(sourceMap.sources, replaceTurbopackSourcePrefix),
    }),
    ...("sections" in sourceMap && {
      sections: sourceMap.sections.map((section) => ({
        ...section,
        map: {
          ...section.map,
          sources: transformSources(section.map.sources, replaceTurbopackSourcePrefix),
        },
      })),
    }),
  };
}

function isSourceMapWithDebugId(value: unknown): value is SourceMapWithDebugId {
  return (
    typeof value === "object" &&
    value !== null &&
    "debugId" in value &&
    typeof value.debugId === "string"
  );
}

export function withSourceMaps(nextConfig: NextConfig, options: SourceMapOptions): NextConfig {
  nextConfig.serverExternalPackages ??= [];
  nextConfig.serverExternalPackages.push("source-map");

  nextConfig.turbopack ??= {};
  nextConfig.turbopack.debugIds = true;

  nextConfig.productionBrowserSourceMaps = true;

  nextConfig.compiler ??= {};
  const runAfterProductionCompile = nextConfig.compiler.runAfterProductionCompile;
  nextConfig.compiler.runAfterProductionCompile = async (args: CompileArgs) => {
    const { join } = await import("node:path");
    const { readFile, rm } = await import("node:fs/promises");
    const { glob } = await import("tinyglobby");

    const store = await options.store(args.distDir);

    const promises: Promise<void>[] = [];
    for (const mapFile of await glob(join(args.distDir, "**", "*.{m,c,}js.map"))) {
      promises.push(
        readFile(mapFile, "utf8").then(async (content) => {
          try {
            const parsed: unknown = JSON.parse(content);
            if (!isSourceMapWithDebugId(parsed)) {
              return;
            }

            const sourceMap =
              options.replaceTurbopackSourcePrefix === undefined
                ? parsed
                : transformSourceMapPaths(parsed, options.replaceTurbopackSourcePrefix);

            await store.put(sourceMap.debugId, JSON.stringify(sourceMap));
          } finally {
            await rm(mapFile);
          }
        }),
      );
    }
    await Promise.allSettled(promises);
    store.close?.();

    await runAfterProductionCompile?.(args);
  };
  return nextConfig;
}
