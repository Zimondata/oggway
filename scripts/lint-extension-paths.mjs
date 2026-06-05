#!/usr/bin/env node
// Lint extension skill/prompt markdown for relative paths that break at runtime.
//
// Agents running extension skills have cwd = the target repo (worktree), NOT the
// claudeclaw root. So `extensions/...`, `prompts/...`, `scripts/...` relative paths
// inside commands (Read/node/tsx/bash/...) resolve to ENOENT and the skill silently
// runs without its rules. Use $CLAUDECLAW_PROJECT_DIR/extensions/... absolute paths.
//
// A skill that intentionally runs from the claudeclaw root (e.g. install/migration
// maintenance skills invoked in the instance dir) can opt out by adding this marker
// anywhere in the file:
//   lint-paths: allow-relative
//
// Incident: 2026-05-27T09-59-05-400Z-m0wsne

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename, sep } from 'node:path';

const ROOT = 'extensions';
const ALLOW_MARKER = 'lint-paths: allow-relative';

// A path token that is relative (not absolute, not $VAR-prefixed). The negative
// lookbehind rejects a preceding `/` ($CLAUDECLAW_PROJECT_DIR/extensions, /Users/.../extensions),
// `$`, `.`, `-`, or a word char, so only bare relative references match.
const PATH_TOKEN = /(?<![\w$./-])(?:extensions|prompts|scripts)\/[\w.-]+/g;

// Command keywords that signal the path is being used as a filesystem path.
const COMMAND_KEYWORD = /\b(?:Read|Write|Edit|cat|node|tsx|ts-node|bash|sh|npm|npx|python3?|source|cd|ls|cp|mv|head|tail|less|require|import)\b/;

/** @returns {string[]} markdown files under extensions/ that are skill/prompt docs */
function collectFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // extensions/ absent (fresh repo) — nothing to lint
  }
  const out = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      out.push(...collectFiles(full));
    } else if (e.isFile() && e.name.endsWith('.md') && inScope(full)) {
      out.push(full);
    }
  }
  return out;
}

/** SKILL.md anywhere, or any .md under a skills/ or prompts/ segment. */
function inScope(file) {
  if (basename(file) === 'SKILL.md') return true;
  const segs = file.split(sep);
  return segs.includes('skills') || segs.includes('prompts');
}

function lintFile(file) {
  const text = readFileSync(file, 'utf8');
  if (text.includes(ALLOW_MARKER)) return [];

  const lines = text.split('\n');
  const violations = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    for (const m of line.matchAll(PATH_TOKEN)) {
      const before = m.index > 0 ? line[m.index - 1] : '';
      const isCommand = inFence || COMMAND_KEYWORD.test(line) || before === '`';
      if (isCommand) {
        violations.push({ file, line: i + 1, match: m[0], text: line.trim() });
      }
    }
  }
  return violations;
}

const files = collectFiles(ROOT);
const violations = files.flatMap(lintFile);

if (violations.length > 0) {
  console.error(`\nRelative paths found in extension skill/prompt files (${violations.length}):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    relative path: '${v.match}'`);
    console.error(`    > ${v.text}`);
  }
  console.error(
    `\nAgent cwd is the target repo (worktree), not the claudeclaw root, so these resolve to ENOENT.\n` +
      `Use an absolute prefix like $CLAUDECLAW_PROJECT_DIR/extensions/... instead.\n` +
      `If a skill genuinely runs from the claudeclaw root, add the marker '${ALLOW_MARKER}' to the file.\n`
  );
  process.exit(1);
}

console.log(`lint:paths ok — ${files.length} extension skill/prompt file(s) clean`);
