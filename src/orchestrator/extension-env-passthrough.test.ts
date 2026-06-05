/**
 * Integration test: env vars declared in a prompt-only extension's
 * manifest.json (provides.envKeys) must reach the agent runner.
 *
 * Regression guard for incident 2026-05-27T10-08-51-097Z-wcqv1c: a prompt-only
 * extension (manifest + skills, no registerExtension() code) declared envKeys
 * that were silently dropped because the loader only read provides.allowedDomains
 * and the runner only merged getExtensionContainerEnvKeys() (code-registered).
 *
 * Scope note: the incident proposed test/integration/env-passthrough.test.ts,
 * but vitest.config.ts only includes src/**\/*.test.ts, so this lives in src/
 * to actually run. It exercises the real loader scan against a temp extensions
 * dir, then reproduces the env-construction step the runners perform.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getExtensionDeclaredEnvKeys } from './extension-loader.js';

const TEST_VAR = 'CCLAW_TEST_VAR';
const TEST_VALUE = 'expected-value-xyz';

let tmpExtensionsDir: string;

function writeManifest(dirName: string, manifest: unknown): void {
  const extDir = path.join(tmpExtensionsDir, dirName);
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

beforeAll(() => {
  tmpExtensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cclaw-envpass-'));
  process.env[TEST_VAR] = TEST_VALUE;
});

afterAll(() => {
  delete process.env[TEST_VAR];
  fs.rmSync(tmpExtensionsDir, { recursive: true, force: true });
});

describe('extension manifest env passthrough', () => {
  it('collects provides.envKeys from a prompt-only extension manifest', () => {
    writeManifest('claudeclaw-test-envpassthrough', {
      name: 'claudeclaw-test-envpassthrough',
      version: '0.0.1',
      type: 'extension',
      entry: 'index.js',
      provides: { envKeys: [TEST_VAR] },
    });

    const declared = getExtensionDeclaredEnvKeys(tmpExtensionsDir);
    expect(declared).toContain(TEST_VAR);
  });

  it('preserves the env var value when the runner builds its filtered env', () => {
    // Mirror the safeEnvKeys -> filteredEnv construction in sandbox-runner.ts.
    const safeEnvKeys = ['PATH', 'HOME', ...getExtensionDeclaredEnvKeys(tmpExtensionsDir)];
    const filteredEnv: Record<string, string> = {};
    for (const key of safeEnvKeys) {
      if (process.env[key]) filteredEnv[key] = process.env[key]!;
    }

    expect(filteredEnv[TEST_VAR]).toBe(TEST_VALUE);
  });

  it('does NOT pass through env vars when the manifest omits them (gating is real)', () => {
    const negativeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cclaw-envpass-neg-'));
    try {
      const extDir = path.join(negativeDir, 'claudeclaw-test-noenv');
      fs.mkdirSync(extDir, { recursive: true });
      fs.writeFileSync(
        path.join(extDir, 'manifest.json'),
        JSON.stringify({
          name: 'claudeclaw-test-noenv',
          version: '0.0.1',
          type: 'extension',
          entry: 'index.js',
          provides: {},
        }),
      );

      const declared = getExtensionDeclaredEnvKeys(negativeDir);
      expect(declared).not.toContain(TEST_VAR);
    } finally {
      fs.rmSync(negativeDir, { recursive: true, force: true });
    }
  });
});
