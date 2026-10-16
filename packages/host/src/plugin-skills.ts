// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 OpenAI
// 改写自 openai/codex，提交 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d，codex-rs/skills/src/parser.rs、ext/skills/src/loader/{mod,discovery}.rs。
// 修改：TypeScript / yaml；复用 Codex 的 frontmatter、标量修复、空白归一化、Unicode 长度与扫描限制；返回 Host 的元数据。
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Skill } from '@wevir/protocol';
import { parse } from 'yaml';

export const MAX_SKILL_DEPTH = 6;
export const MAX_SKILL_DIRS = 2000;
const MAX_SKILL_BYTES = 1024 * 1024;

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Codex 对不带引号的 `description: AWS: ECS` 等第三方标量做一次行修复。 */
function repair(text: string): string {
  let blockIndent: number | undefined;
  return text
    .split('\n')
    .map((line) => {
      const indent = line.length - line.trimStart().length;
      if (blockIndent !== undefined) {
        if (!line.trim() || indent > blockIndent) return line;
        blockIndent = undefined;
      }
      const match = /^(\s*[^:]+:)(\s+)(.*)$/.exec(line);
      if (!match) return line;
      const [, key, space, raw = ''] = match;
      const comment = /\s+#.*$/.exec(raw);
      const scalar = (comment ? raw.slice(0, comment.index) : raw).trimEnd();
      if (/^[|>]/.test(scalar)) {
        blockIndent = indent;
        return line;
      }
      if (/^['"]/.test(scalar)) return line;
      let invalidFlow = false;
      if (/^[[{@`]/.test(scalar)) {
        try {
          parse(scalar);
        } catch {
          invalidFlow = true;
        }
      }
      return /:\s/.test(scalar) || invalidFlow
        ? `${key}${space}'${scalar.replaceAll("'", "''")}'${comment?.[0] ?? ''}`
        : line;
    })
    .join('\n');
}

const singleLine = (value: string) => value.trim().split(/\s+/u).join(' ');
export function parseSkill(
  contents: string,
  defaultName: string,
): Pick<Skill, 'name' | 'description' | 'shortDescription'> {
  const lines = contents.split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (lines[0]?.trim() !== '---' || end <= 1) throw new Error('SKILL.md requires YAML frontmatter');
  const yaml = lines.slice(1, end).join('\n');
  let value: unknown;
  try {
    value = parse(yaml);
  } catch {
    try {
      value = parse(repair(yaml));
    } catch {
      throw new Error('Invalid SKILL.md YAML frontmatter');
    }
  }
  const data = record(value);
  const metadata = record(data.metadata);
  if (
    (data.name !== undefined && data.name !== null && typeof data.name !== 'string') ||
    typeof data.description !== 'string' ||
    (data.metadata !== undefined &&
      (data.metadata === null ||
        typeof data.metadata !== 'object' ||
        Array.isArray(data.metadata))) ||
    (metadata['short-description'] !== undefined &&
      metadata['short-description'] !== null &&
      typeof metadata['short-description'] !== 'string')
  ) {
    throw new Error('Invalid SKILL.md metadata fields');
  }
  const name = typeof data.name === 'string' ? singleLine(data.name) || defaultName : defaultName;
  const description = singleLine(data.description);
  const shortDescription =
    typeof metadata['short-description'] === 'string'
      ? singleLine(metadata['short-description'])
      : '';
  if (!name || Array.from(name).length > 64)
    throw new Error('Skill name must contain 1–64 characters');
  if (!description || Array.from(description).length > 1024)
    throw new Error('Skill description must contain 1–1024 characters');
  return { name, description, ...(shortDescription && { shortDescription }) };
}

export async function readSkill(
  path: string,
): Promise<Pick<Skill, 'name' | 'description' | 'shortDescription'>> {
  if ((await lstat(path)).size > MAX_SKILL_BYTES) throw new Error('SKILL.md is too large');
  return parseSkill(await readFile(path, 'utf8'), basename(dirname(path)));
}

export async function scanSkills(
  root: string,
  source: Skill['source'],
  strict = false,
): Promise<Skill[]> {
  const found: Skill[] = [];
  const seen = new Set<string>();
  let count = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_SKILL_DEPTH || count++ >= MAX_SKILL_DIRS) return;
    let canonical: string;
    try {
      canonical = await realpath(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (seen.has(canonical)) return;
    seen.add(canonical);
    const entries = await readdir(canonical, { withFileTypes: true });
    if (
      entries.some(
        (entry) => entry.name === 'SKILL.md' && (entry.isFile() || entry.isSymbolicLink()),
      )
    ) {
      try {
        const path = await realpath(join(canonical, 'SKILL.md'));
        found.push({
          id: path,
          ...(await readSkill(path)),
          path,
          source,
          enabled: source === 'wevir',
        });
      } catch (error) {
        if (strict) throw error;
      }
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      try {
        await walk(join(canonical, entry.name), depth + 1);
      } catch (error) {
        if (strict) throw error;
      }
    }
  };
  await walk(root, 0);
  return found;
}
