/**
 * Interface for source map storage backends.
 *
 * Implementations store and retrieve source map JSON by debug ID.
 * Built-in implementations: SQLite (local), HTTP (remote).
 */
export interface SourceMapStore {
  /**
   * Releases resources held by the store.
   */
  readonly close?: () => void;
  /**
   * Retrieves a source map by debug ID.
   * @returns The source map JSON string, or null if not found.
   */
  readonly get: (debugId: string) => string | null | Promise<string | null>;

  /**
   * Stores a source map by debug ID.
   * @param debugId The debug ID (UUID) for the source map.
   * @param content The source map JSON string.
   */
  readonly put: (debugId: string, content: string) => void | Promise<void>;
}
