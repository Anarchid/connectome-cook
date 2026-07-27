/**
 * Recipe → configuration lowering.
 *
 * A *recipe* is declarative intent: it may carry `source` blocks, unbound
 * `${VAR}` references, and host-relative paths. A *configuration* is the
 * fully-resolved artifact the runtime loads — overlays applied (in-container
 * paths substituted) and build-only `source` blocks demoted to `sourceMeta`
 * provenance. Every backend ships configurations, never raw recipes; these
 * helpers are the shared lowering step.
 */

import { basename, isAbsolute } from 'node:path';
import { slugify } from './slug.js';
import { sourceBaseFor } from './walker.js';
import {
  resolveRecipeRelative,
  type Recipe,
  type RecipeExtension,
  type RecipeFleet,
  type RecipeMcpServer,
} from './vendor/recipe.js';

/** Apply a Partial<Recipe> overlay to a Recipe with shallow per-entry merge
 *  for mcpServers and extensions. Matches the contract `generateOverlays`
 *  documents — only the fields a generator wants to override are present. */
export function applyOverlay(recipe: Recipe, overlay: Partial<Recipe> | undefined): Recipe {
  if (!overlay) return recipe;
  const merged: Recipe = { ...recipe };
  if (overlay.mcpServers) {
    merged.mcpServers = { ...(recipe.mcpServers ?? {}) };
    for (const [name, overlayServer] of Object.entries(overlay.mcpServers)) {
      const original = recipe.mcpServers?.[name];
      merged.mcpServers[name] = original
        ? { ...original, ...(overlayServer as Partial<RecipeMcpServer>) }
        : (overlayServer as RecipeMcpServer);
    }
  }
  if (overlay.extensions) {
    merged.extensions = { ...(recipe.extensions ?? {}) };
    for (const [name, overlayExt] of Object.entries(overlay.extensions)) {
      const original = recipe.extensions?.[name];
      merged.extensions[name] = original
        ? { ...original, ...(overlayExt as Partial<RecipeExtension>) }
        : (overlayExt as RecipeExtension);
    }
  }
  return merged;
}

/** Demote each mcpServer's and extension's build-only `source` block to
 *  `sourceMeta` before the recipe is shipped as a configuration. The runtime
 *  loader validates `source` yet never uses it — it's build-tooling metadata
 *  that cook alone consumes. Renaming keeps the provenance visible to anyone
 *  reading the shipped file without tripping runtime validation. */
export function demoteMcpSource(recipe: Recipe): Recipe {
  let result = recipe;
  if (recipe.mcpServers) {
    const mcpServers: Record<string, RecipeMcpServer> = {};
    for (const [name, server] of Object.entries(recipe.mcpServers)) {
      const { source, ...rest } = server;
      mcpServers[name] = source === undefined ? rest : { ...rest, sourceMeta: source };
    }
    result = { ...result, mcpServers };
  }
  if (recipe.extensions) {
    const extensions: Record<string, RecipeExtension> = {};
    for (const [name, ext] of Object.entries(recipe.extensions)) {
      const { source, ...rest } = ext;
      extensions[name] = source === undefined ? rest : { ...rest, sourceMeta: source };
    }
    result = { ...result, extensions };
  }
  return result;
}

/** Pick the output filename for one walked recipe.  File-paths use basename
 *  as-is so the in-container layout matches what operators wrote.  URLs get
 *  slugified plus `.json`. */
export function recipeFilename(walkPath: string): string {
  if (walkPath.startsWith('http://') || walkPath.startsWith('https://')) {
    return `${slugify(walkPath)}.json`;
  }
  return basename(walkPath);
}

/**
 * Rewrite recipe-to-recipe references for the flat `recipes/` layout every
 * backend ships. The runtime loader resolves `fleet.children[].recipe`
 * against the parent recipe file's own directory, but backends copy every
 * walked recipe flat into `<out>/recipes/` — a source-relative ref like
 * `./recipes/child.json` would double the path segment once the shipped
 * parent itself lives under `recipes/`. Since all walked recipes land in one
 * directory, the correct shipped ref is always `./<shipped filename>`.
 *
 * Children are rewritten unconditionally (absolute and URL refs included:
 * the walker shipped a copy, and the original location may not exist on the
 * deployment host). `allowedRecipes` entries are launch-time match patterns,
 * not loader paths: relative non-glob entries are rewritten the same way so
 * they stay consistent with the rewritten child refs; glob patterns and
 * absolute/URL entries (which mean the same thing regardless of where the
 * recipe file sits) pass through untouched.
 */
export function rewriteFleetRefs(recipe: Recipe, walkPath: string): Recipe {
  const fleet = recipe.modules?.fleet;
  if (!fleet || typeof fleet !== 'object') return recipe;
  const children = fleet.children ?? [];
  const allowed = fleet.allowedRecipes ?? [];
  if (children.length === 0 && allowed.length === 0) return recipe;

  const base = sourceBaseFor(walkPath);
  const shippedRef = (ref: string): string =>
    `./${recipeFilename(resolveRecipeRelative(ref, base))}`;
  const isRelativePath = (ref: string): boolean =>
    !isAbsolute(ref) && !ref.startsWith('http://') && !ref.startsWith('https://');

  const rewritten: RecipeFleet = { ...fleet };
  if (children.length > 0) {
    rewritten.children = children.map((c) => ({ ...c, recipe: shippedRef(c.recipe) }));
  }
  if (allowed.length > 0) {
    rewritten.allowedRecipes = allowed.map((p) =>
      !p.includes('*') && isRelativePath(p) ? shippedRef(p) : p,
    );
  }
  return { ...recipe, modules: { ...recipe.modules, fleet: rewritten } };
}

/**
 * Detect walked recipes that would collide in the flat `recipes/` output
 * directory. Returns a map of shipped filename → source paths, containing
 * only filenames claimed by more than one walk. Callers should treat any
 * non-empty result as fatal: a silent flat-copy overwrite ships a fleet
 * whose children load the wrong recipe.
 */
export function detectRecipeFilenameCollisions(
  walkPaths: string[],
): Map<string, string[]> {
  const byFilename = new Map<string, string[]>();
  for (const path of walkPaths) {
    const filename = recipeFilename(path);
    const existing = byFilename.get(filename);
    if (existing) existing.push(path);
    else byFilename.set(filename, [path]);
  }
  for (const [filename, paths] of byFilename) {
    if (paths.length < 2) byFilename.delete(filename);
  }
  return byFilename;
}

/** Lower a recipe to its shipped configuration: rewrite fleet refs for the
 *  flat recipes/ layout, overlay, then demote. `walkPath` is the location
 *  the recipe was loaded from (absolute file path or URL). */
export function lowerToConfiguration(
  recipe: Recipe,
  overlay: Partial<Recipe> | undefined,
  walkPath: string,
): Recipe {
  return demoteMcpSource(applyOverlay(rewriteFleetRefs(recipe, walkPath), overlay));
}
