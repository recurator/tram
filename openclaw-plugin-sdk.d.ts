/**
 * Type declarations for openclaw/plugin-sdk
 *
 * This module is provided by the openclaw peer dependency and is used
 * to register plugin hooks with OpenClaw's event system.
 *
 * See: https://docs.openclaw.ai/plugin
 */

declare module "openclaw/plugin-sdk" {
  import type { OpenClawPluginApi } from "./index.js";

  /**
   * Register plugin hooks from a directory.
   *
   * This function discovers HOOK.md files in the specified directory,
   * parses their frontmatter to determine event bindings, and registers
   * the corresponding handler.ts exports with OpenClaw's event system.
   *
   * @param api - The OpenClaw plugin API instance
   * @param hooksDir - Path to the hooks directory (containing subdirectories with HOOK.md and handler.ts)
   *
   * @example
   * ```typescript
   * import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";
   *
   * export default function register(api) {
   *   registerPluginHooksFromDir(api, "./hooks");
   * }
   * ```
   */
  /**
   * Register plugin hooks from a directory.
   * Note: This function may not exist in all OpenClaw versions.
   * Always check `typeof registerPluginHooksFromDir === "function"` before calling.
   */
  export const registerPluginHooksFromDir:
    | ((api: OpenClawPluginApi, hooksDir: string) => void)
    | undefined;
}
