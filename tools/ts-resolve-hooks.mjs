/**
 * Minimal Node ESM resolver hooks so the browser-facing TypeScript modules can
 * be imported and tested directly under `node`.
 *
 * Vite resolves extensionless relative imports (`./audioFormat` → `.ts`); plain
 * Node does not. Node's built-in type stripping handles the syntax, so this only
 * has to fill in the extension.
 *
 * Used via `--import ./tools/register_ts_resolve.mjs`.
 */

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$|\.json$/i.test(specifier)) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      // Fall through to the default resolution below.
    }
  }
  return nextResolve(specifier, context);
}
