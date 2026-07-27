import { describe, expect, test } from 'bun:test';
import {
  detectRecipeFilenameCollisions,
  lowerToConfiguration,
  rewriteFleetRefs,
} from './configuration.js';
import type { Recipe } from './vendor/recipe.js';

/** Minimal valid-enough recipe for lowering tests. */
function fleetRecipe(fleet: Record<string, unknown>): Recipe {
  return {
    name: 'parent',
    llm: { provider: 'anthropic', model: 'claude-sonnet-5' },
    modules: { fleet },
  } as unknown as Recipe;
}

describe('rewriteFleetRefs', () => {
  test('rewrites subdirectory child refs to flat shipped filenames (issue #9)', () => {
    // Layout from the issue: parent at /repo/zkchar.json referencing
    // ./recipes/commander.json — flat copy would double the segment.
    const recipe = fleetRecipe({
      children: [{ name: 'commander', recipe: './recipes/commander.json' }],
    });
    const out = rewriteFleetRefs(recipe, '/repo/zkchar.json');
    const fleet = out.modules?.fleet as { children: { recipe: string }[] };
    expect(fleet.children[0]?.recipe).toBe('./commander.json');
  });

  test('rewrites parent-dir child refs (../shared/child.json)', () => {
    const recipe = fleetRecipe({
      children: [{ name: 'c', recipe: '../shared/child.json' }],
    });
    const out = rewriteFleetRefs(recipe, '/repo/fleet/parent.json');
    const fleet = out.modules?.fleet as { children: { recipe: string }[] };
    expect(fleet.children[0]?.recipe).toBe('./child.json');
  });

  test('co-located refs are unchanged in effect (./child.json stays ./child.json)', () => {
    const recipe = fleetRecipe({
      children: [{ name: 'c', recipe: './child.json' }],
    });
    const out = rewriteFleetRefs(recipe, '/repo/recipes/parent.json');
    const fleet = out.modules?.fleet as { children: { recipe: string }[] };
    expect(fleet.children[0]?.recipe).toBe('./child.json');
  });

  test('absolute child refs are rewritten too — the walker shipped a copy', () => {
    const recipe = fleetRecipe({
      children: [{ name: 'c', recipe: '/somewhere/else/child.json' }],
    });
    const out = rewriteFleetRefs(recipe, '/repo/parent.json');
    const fleet = out.modules?.fleet as { children: { recipe: string }[] };
    expect(fleet.children[0]?.recipe).toBe('./child.json');
  });

  test('URL child refs become the slugified shipped filename', () => {
    const recipe = fleetRecipe({
      children: [{ name: 'c', recipe: 'https://example.com/recipes/child.json' }],
    });
    const out = rewriteFleetRefs(recipe, '/repo/parent.json');
    const fleet = out.modules?.fleet as { children: { recipe: string }[] };
    expect(fleet.children[0]?.recipe).toMatch(/^\.\/.+\.json$/);
    expect(fleet.children[0]?.recipe).not.toContain('://');
  });

  test('allowedRecipes: relative exact entries rewritten, globs and absolute kept', () => {
    const recipe = fleetRecipe({
      children: [{ name: 'c', recipe: './recipes/child.json' }],
      allowedRecipes: [
        './recipes/child.json',
        './recipes/*',
        '*',
        '/opt/recipes/other.json',
        'https://example.com/r.json',
      ],
    });
    const out = rewriteFleetRefs(recipe, '/repo/parent.json');
    const fleet = out.modules?.fleet as { allowedRecipes: string[] };
    expect(fleet.allowedRecipes).toEqual([
      './child.json',
      './recipes/*',
      '*',
      '/opt/recipes/other.json',
      'https://example.com/r.json',
    ]);
  });

  test('recipes without a fleet module pass through untouched', () => {
    const recipe = {
      name: 'leaf',
      llm: { provider: 'anthropic', model: 'claude-sonnet-5' },
      modules: { lessons: true },
    } as unknown as Recipe;
    expect(rewriteFleetRefs(recipe, '/repo/leaf.json')).toBe(recipe);
  });

  test('does not mutate the input recipe', () => {
    const recipe = fleetRecipe({
      children: [{ name: 'c', recipe: './recipes/child.json' }],
    });
    rewriteFleetRefs(recipe, '/repo/parent.json');
    const fleet = recipe.modules?.fleet as { children: { recipe: string }[] };
    expect(fleet.children[0]?.recipe).toBe('./recipes/child.json');
  });

  test('resolves against a URL-loaded parent base', () => {
    const recipe = fleetRecipe({
      children: [{ name: 'c', recipe: './recipes/child.json' }],
    });
    const out = rewriteFleetRefs(recipe, 'https://example.com/fleet/parent.json');
    const fleet = out.modules?.fleet as { children: { recipe: string }[] };
    // Child resolves to https://example.com/fleet/recipes/child.json → slug.
    expect(fleet.children[0]?.recipe).toMatch(/^\.\/.+\.json$/);
    expect(fleet.children[0]?.recipe).not.toContain('://');
  });
});

describe('lowerToConfiguration', () => {
  test('applies the fleet rewrite as part of lowering', () => {
    const recipe = fleetRecipe({
      children: [{ name: 'commander', recipe: './recipes/commander.json' }],
    });
    const out = lowerToConfiguration(recipe, undefined, '/repo/zkchar.json');
    const fleet = out.modules?.fleet as { children: { recipe: string }[] };
    expect(fleet.children[0]?.recipe).toBe('./commander.json');
  });
});

describe('detectRecipeFilenameCollisions', () => {
  test('flags two walks that flatten to the same basename', () => {
    const collisions = detectRecipeFilenameCollisions([
      '/repo/parent.json',
      '/repo/a/agent.json',
      '/repo/b/agent.json',
    ]);
    expect(collisions.size).toBe(1);
    expect(collisions.get('agent.json')).toEqual([
      '/repo/a/agent.json',
      '/repo/b/agent.json',
    ]);
  });

  test('returns empty for distinct basenames', () => {
    const collisions = detectRecipeFilenameCollisions([
      '/repo/parent.json',
      '/repo/recipes/child.json',
    ]);
    expect(collisions.size).toBe(0);
  });
});
