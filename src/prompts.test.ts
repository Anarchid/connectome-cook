/**
 * Tests for the prompt-support helpers in prompts.ts — specifically the
 * Anthropic-credential either/or behavior (ANTHROPIC_API_KEY satisfiable by
 * the ANTHROPIC_AUTH_TOKEN alternative via `RequiredVar.altNames`).
 *
 * Coverage:
 *   1. deriveRequiredVars: the always-required ANTHROPIC_API_KEY entry
 *      carries ANTHROPIC_AUTH_TOKEN in altNames.
 *   2. resolvePresent: an env-file with only ANTHROPIC_AUTH_TOKEN satisfies
 *      the ANTHROPIC_API_KEY requirement (nothing missing; the token value
 *      is recorded under its own name so it lands in .env as-is).
 *   3. resolvePresent: neither var present → ANTHROPIC_API_KEY is missing.
 *   4. resolvePresent: both present → both recorded (connectome-host's
 *      both-set preference for the auth token applies downstream).
 *
 * The interactive promptForVars flow (skip primary → offered the alt) is
 * not driven here — it needs a TTY harness; the alt-prompt branch is pure
 * plumbing over the same altNames field exercised below.
 *
 * process.env hygiene: resolvePresent falls back to process.env, so tests
 * that assert "missing" must scrub both vars for the duration and restore
 * them after — the dev machine may legitimately export either one.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { deriveRequiredVars, resolvePresent } from './prompts.js';

const CRED_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const name of CRED_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of CRED_VARS) {
    if (saved[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = saved[name];
    }
  }
});

describe('deriveRequiredVars — Anthropic credential', () => {
  test('ANTHROPIC_API_KEY entry lists ANTHROPIC_AUTH_TOKEN as an alternative', () => {
    const required = deriveRequiredVars([], []);
    const anthropic = required.find((v) => v.name === 'ANTHROPIC_API_KEY');
    expect(anthropic).toBeDefined();
    expect(anthropic!.altNames).toEqual(['ANTHROPIC_AUTH_TOKEN']);
  });
});

describe('resolvePresent — altNames satisfaction', () => {
  test('ANTHROPIC_AUTH_TOKEN alone satisfies the ANTHROPIC_API_KEY requirement', () => {
    const required = deriveRequiredVars([], []);
    const { found, missing } = resolvePresent(required, {
      ANTHROPIC_AUTH_TOKEN: 'sk-ant-oat01-abc',
    });
    expect(missing.map((v) => v.name)).not.toContain('ANTHROPIC_API_KEY');
    // Recorded under its own name — it must land in .env as-is.
    expect(found['ANTHROPIC_AUTH_TOKEN']).toBe('sk-ant-oat01-abc');
    expect(found['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  test('neither credential present → ANTHROPIC_API_KEY reported missing', () => {
    const required = deriveRequiredVars([], []);
    const { missing } = resolvePresent(required, {});
    expect(missing.map((v) => v.name)).toContain('ANTHROPIC_API_KEY');
  });

  test('empty-string auth token does not satisfy the requirement', () => {
    // resolveValue treats empty string as unset (operators `export FOO=`
    // to clear) — the alt path must inherit that.
    const required = deriveRequiredVars([], []);
    const { missing } = resolvePresent(required, {
      ANTHROPIC_AUTH_TOKEN: '',
    });
    expect(missing.map((v) => v.name)).toContain('ANTHROPIC_API_KEY');
  });

  test('both credentials present → both recorded', () => {
    const required = deriveRequiredVars([], []);
    const { found, missing } = resolvePresent(required, {
      ANTHROPIC_API_KEY: 'sk-ant-key',
      ANTHROPIC_AUTH_TOKEN: 'sk-ant-oat01-abc',
    });
    expect(missing.map((v) => v.name)).not.toContain('ANTHROPIC_API_KEY');
    expect(found['ANTHROPIC_API_KEY']).toBe('sk-ant-key');
    // Both land in .env; connectome-host prefers the auth token at runtime.
    expect(found['ANTHROPIC_AUTH_TOKEN']).toBe('sk-ant-oat01-abc');
  });

  test('vars without altNames behave exactly as before', () => {
    const required = deriveRequiredVars(
      [
        {
          name: 'GITLAB_TOKEN',
          usedIn: [{ recipePath: '/r/a.json', jsonPath: 'mcpServers.gitlab.env.GITLAB_TOKEN' }],
        },
      ],
      [],
    );
    const { found, missing } = resolvePresent(required, {
      ANTHROPIC_API_KEY: 'sk-ant-key',
    });
    expect(found['GITLAB_TOKEN']).toBeUndefined();
    expect(missing.map((v) => v.name)).toContain('GITLAB_TOKEN');
  });
});
