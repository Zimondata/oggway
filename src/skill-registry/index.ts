import fs from 'fs';
import path from 'path';

import { registerExtension } from '../orchestrator/extensions.js';
import { getDb } from '../orchestrator/db.js';
import { resolveGroupFolderPath } from '../orchestrator/group-folder.js';
import { logger } from '../orchestrator/logger.js';

registerExtension({
  name: 'skill-registry',
  ipcHandlers: {
    skill_save: async (data: unknown, sourceGroup: string) => {
      const payload = data as {
        name?: string;
        problem?: string;
        approach?: string;
        gotchas?: string;
        filesTouched?: string[];
      };
      if (!payload.name || !payload.problem || !payload.approach) {
        logger.warn(
          { sourceGroup, payload },
          'skill_save IPC missing required fields',
        );
        return;
      }
      try {
        saveSkill({
          groupFolder: sourceGroup,
          name: payload.name,
          problem: payload.problem,
          approach: payload.approach,
          gotchas: payload.gotchas,
          filesTouched: payload.filesTouched,
        });
      } catch (err) {
        logger.error(
          { err, sourceGroup, name: payload.name },
          'skill_save failed',
        );
      }
    },
  },
  dbSchema: [
    `CREATE TABLE IF NOT EXISTS skills (
       id TEXT PRIMARY KEY,
       group_folder TEXT NOT NULL,
       name TEXT NOT NULL,
       problem TEXT NOT NULL,
       approach TEXT NOT NULL,
       gotchas TEXT,
       files_touched TEXT,
       utility_score REAL DEFAULT 1.0,
       success_count INTEGER DEFAULT 0,
       failure_count INTEGER DEFAULT 0,
       version INTEGER DEFAULT 1,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_skills_group ON skills(group_folder)`,
    `CREATE INDEX IF NOT EXISTS idx_skills_utility ON skills(group_folder, utility_score DESC)`,
    `CREATE TABLE IF NOT EXISTS skill_usage (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       skill_id TEXT NOT NULL,
       group_folder TEXT NOT NULL,
       outcome TEXT,
       run_at TEXT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_skill_usage_skill ON skill_usage(skill_id)`,
  ],
});

export interface SkillRecord {
  id: string;
  groupFolder: string;
  name: string;
  problem: string;
  approach: string;
  gotchas?: string;
  filesTouched?: string;
  utilityScore: number;
  successCount: number;
  failureCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SaveSkillInput {
  groupFolder: string;
  name: string;
  problem: string;
  approach: string;
  gotchas?: string;
  filesTouched?: string[];
}

interface SkillRow {
  id: string;
  group_folder: string;
  name: string;
  problem: string;
  approach: string;
  gotchas: string | null;
  files_touched: string | null;
  utility_score: number;
  success_count: number;
  failure_count: number;
  version: number;
  created_at: string;
  updated_at: string;
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function mapRow(row: SkillRow): SkillRecord {
  return {
    id: row.id,
    groupFolder: row.group_folder,
    name: row.name,
    problem: row.problem,
    approach: row.approach,
    gotchas: row.gotchas ?? undefined,
    filesTouched: row.files_touched ?? undefined,
    utilityScore: row.utility_score,
    successCount: row.success_count,
    failureCount: row.failure_count,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function skillFilePath(groupFolder: string, normalizedName: string): string {
  const groupPath = resolveGroupFolderPath(groupFolder);
  return path.join(groupPath, 'skills', `${normalizedName}.md`);
}

function findDuplicate(
  groupFolder: string,
  normalizedName: string,
  problemPrefix: string,
): SkillRecord | null {
  const db = getDb();
  const byName = db
    .prepare(`SELECT * FROM skills WHERE group_folder = ? AND name = ?`)
    .get(groupFolder, normalizedName) as SkillRow | undefined;
  if (byName) return mapRow(byName);

  if (problemPrefix.length === 0) return null;
  const byProblem = db
    .prepare(
      `SELECT * FROM skills WHERE group_folder = ? AND substr(problem, 1, 200) = ?`,
    )
    .get(groupFolder, problemPrefix) as SkillRow | undefined;
  return byProblem ? mapRow(byProblem) : null;
}

function writeSkillFile(skill: SkillRecord): void {
  const filePath = skillFilePath(skill.groupFolder, skill.name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const lines = [
    '---',
    `id: ${skill.id}`,
    `name: ${skill.name}`,
    `version: ${skill.version}`,
    `utility_score: ${skill.utilityScore.toFixed(3)}`,
    `success_count: ${skill.successCount}`,
    `failure_count: ${skill.failureCount}`,
    `created_at: ${skill.createdAt}`,
    `updated_at: ${skill.updatedAt}`,
    '---',
    '',
    `# ${skill.name}`,
    '',
    '## Problem',
    skill.problem,
    '',
    '## Approach',
    skill.approach,
    '',
  ];
  if (skill.gotchas) {
    lines.push('## Gotchas', skill.gotchas, '');
  }
  if (skill.filesTouched) {
    lines.push('## Files touched', skill.filesTouched, '');
  }
  fs.writeFileSync(filePath, lines.join('\n'));
}

export interface SaveSkillResult {
  merged: boolean;
  skill: SkillRecord;
}

export function saveSkill(input: SaveSkillInput): SaveSkillResult {
  const normalizedName = normalizeName(input.name);
  if (!normalizedName) {
    throw new Error(
      'Skill name must contain at least one alphanumeric character',
    );
  }
  const problemPrefix = input.problem.slice(0, 200);
  const filesTouched = input.filesTouched?.join(', ');
  const existing = findDuplicate(
    input.groupFolder,
    normalizedName,
    problemPrefix,
  );

  const db = getDb();
  const now = new Date().toISOString();

  if (existing) {
    const mergedGotchas = [existing.gotchas, input.gotchas]
      .filter((g): g is string => Boolean(g && g.trim()))
      .join('\n\n');
    db.prepare(
      `UPDATE skills SET
         approach = ?,
         gotchas = ?,
         files_touched = ?,
         version = version + 1,
         updated_at = ?
       WHERE id = ?`,
    ).run(
      input.approach,
      mergedGotchas || null,
      filesTouched || null,
      now,
      existing.id,
    );

    const updatedRow = db
      .prepare(`SELECT * FROM skills WHERE id = ?`)
      .get(existing.id) as SkillRow;
    const updated = mapRow(updatedRow);
    writeSkillFile(updated);
    logger.info(
      {
        groupFolder: input.groupFolder,
        name: normalizedName,
        version: updated.version,
      },
      'Skill merged into existing entry',
    );
    return { merged: true, skill: updated };
  }

  const id = `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO skills (id, group_folder, name, problem, approach, gotchas, files_touched, utility_score, success_count, failure_count, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1.0, 0, 0, 1, ?, ?)`,
  ).run(
    id,
    input.groupFolder,
    normalizedName,
    input.problem,
    input.approach,
    input.gotchas || null,
    filesTouched || null,
    now,
    now,
  );

  const skill: SkillRecord = {
    id,
    groupFolder: input.groupFolder,
    name: normalizedName,
    problem: input.problem,
    approach: input.approach,
    gotchas: input.gotchas,
    filesTouched,
    utilityScore: 1.0,
    successCount: 0,
    failureCount: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  writeSkillFile(skill);
  logger.info(
    { groupFolder: input.groupFolder, name: normalizedName, id },
    'Skill saved',
  );
  return { merged: false, skill };
}

export function searchSkills(
  groupFolder: string,
  query: string,
  topK = 3,
): SkillRecord[] {
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter((t) => t.length >= 3);
  if (queryTerms.length === 0) return [];

  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM skills WHERE group_folder = ?`)
    .all(groupFolder) as SkillRow[];

  const scored = rows
    .map((row) => {
      const text =
        `${row.name} ${row.problem} ${row.approach} ${row.gotchas ?? ''}`.toLowerCase();
      const matchCount = queryTerms.filter((t) => text.includes(t)).length;
      const score = matchCount + (row.utility_score || 1) * 0.1;
      return { row, score, matchCount };
    })
    .filter((s) => s.matchCount > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored.map((s) => mapRow(s.row));
}

export function listSkills(groupFolder: string): SkillRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM skills WHERE group_folder = ? ORDER BY utility_score DESC, updated_at DESC`,
    )
    .all(groupFolder) as SkillRow[];
  return rows.map(mapRow);
}

export function getSkillById(id: string): SkillRecord | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM skills WHERE id = ?`).get(id) as
    | SkillRow
    | undefined;
  return row ? mapRow(row) : null;
}

export type SkillOutcome = 'success' | 'failure';

export function recordSkillUsage(
  skillId: string,
  groupFolder: string,
  outcome: SkillOutcome,
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO skill_usage (skill_id, group_folder, outcome, run_at) VALUES (?, ?, ?, ?)`,
  ).run(skillId, groupFolder, outcome, new Date().toISOString());

  if (outcome === 'success') {
    db.prepare(
      `UPDATE skills SET success_count = success_count + 1 WHERE id = ?`,
    ).run(skillId);
  } else {
    db.prepare(
      `UPDATE skills SET failure_count = failure_count + 1 WHERE id = ?`,
    ).run(skillId);
  }

  const row = db
    .prepare(`SELECT success_count, failure_count FROM skills WHERE id = ?`)
    .get(skillId) as
    | { success_count: number; failure_count: number }
    | undefined;
  if (!row) return;

  const utility =
    1 + Math.log(row.success_count + 1) - 2 * Math.log(row.failure_count + 1);
  db.prepare(`UPDATE skills SET utility_score = ? WHERE id = ?`).run(
    utility,
    skillId,
  );
}

export function formatSkillsForContext(skills: SkillRecord[]): string {
  if (skills.length === 0) return '';
  const blocks = skills.map((s) => {
    const parts = [
      `<skill id="${s.id}" name="${s.name}" utility="${s.utilityScore.toFixed(2)}">`,
      `Problem: ${s.problem}`,
      `Approach: ${s.approach}`,
    ];
    if (s.gotchas) parts.push(`Gotchas: ${s.gotchas}`);
    parts.push('</skill>');
    return parts.join('\n');
  });
  return ['<relevant_skills>', ...blocks, '</relevant_skills>', ''].join('\n');
}
