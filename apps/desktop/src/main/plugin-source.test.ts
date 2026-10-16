import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INSTALL_SOURCE_LIMITS } from '../shared/desktop-api.js';
import { inspectInstallSource, readSkillFile } from './plugin-source.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wevir-plugin-source-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const MANIFEST = { schemaVersion: 1, id: 'sample', name: 'Sample', version: '1.0.0' };

function put(root: string, files: Record<string, string>): string {
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

/** 手写的最小 ZIP：名字以 / 结尾的是目录；`deflate` 里列出的条目用 DEFLATE，其余存储。 */
function zipOf(entries: Record<string, string>, deflate: readonly string[] = []): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const raw = Buffer.from(content);
    const method = deflate.includes(name) ? 8 : 0;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const check = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(check, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(check, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(name.endsWith('/') ? 0o040755 * 0x10000 : 0o100644 * 0x10000, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function zipFile(entries: Record<string, string>, deflate?: readonly string[]): string {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.zip`);
  writeFileSync(path, zipOf(entries, deflate));
  return path;
}

describe('inspectInstallSource：文件夹', () => {
  it('根上有 wevir-plugin.json 的是 Wevir 插件包，带清单', async () => {
    const root = put(join(dir, 'pkg'), { 'wevir-plugin.json': JSON.stringify(MANIFEST) });
    await expect(inspectInstallSource(root)).resolves.toEqual({
      kind: 'plugin',
      format: 'wevir',
      manifest: MANIFEST,
    });
  });

  it('清单带 BOM 也能读，不是 JSON 或太大时没有清单、仍是插件包', async () => {
    const bom = put(join(dir, 'bom'), { 'wevir-plugin.json': `﻿${JSON.stringify(MANIFEST)}` });
    expect(await inspectInstallSource(bom)).toMatchObject({ format: 'wevir', manifest: MANIFEST });
    const broken = put(join(dir, 'broken'), { 'wevir-plugin.json': '{ nope' });
    expect(await inspectInstallSource(broken)).toEqual({ kind: 'plugin', format: 'wevir' });
    const large = put(join(dir, 'large'), {
      'wevir-plugin.json': JSON.stringify({ x: 'a'.repeat(INSTALL_SOURCE_LIMITS.manifestBytes) }),
    });
    expect(await inspectInstallSource(large)).toEqual({ kind: 'plugin', format: 'wevir' });
  });

  it('Claude 与 Codex 的包按清单认，两种都有时先认 Codex（同 Host）', async () => {
    const claude = put(join(dir, 'claude'), { '.claude-plugin/plugin.json': '{"name":"c"}' });
    const codex = put(join(dir, 'codex'), { '.codex-plugin/plugin.json': '{"name":"c"}' });
    const both = put(join(dir, 'both'), {
      '.claude-plugin/plugin.json': '{"name":"c"}',
      '.codex-plugin/plugin.json': '{"name":"c"}',
    });
    expect(await inspectInstallSource(claude)).toEqual({ kind: 'plugin', format: 'claude' });
    expect(await inspectInstallSource(codex)).toEqual({ kind: 'plugin', format: 'codex' });
    expect(await inspectInstallSource(both)).toEqual({ kind: 'plugin', format: 'codex' });
  });

  it('Wevir 清单优先于导入的清单', async () => {
    const root = put(join(dir, 'mixed'), {
      'wevir-plugin.json': JSON.stringify(MANIFEST),
      '.claude-plugin/plugin.json': '{"name":"c"}',
    });
    expect(await inspectInstallSource(root)).toMatchObject({ kind: 'plugin', format: 'wevir' });
  });

  it('只有标记目录、没有清单文件时也当插件包（同 Host 的 skill.install）', async () => {
    const root = join(dir, 'hollow');
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    expect(await inspectInstallSource(root)).toEqual({ kind: 'plugin', format: 'claude' });
  });

  it('其他文件夹是 Skills（一个或多个，深浅都行）', async () => {
    const one = put(join(dir, 'one'), { 'SKILL.md': '---\nname: a\n---\n' });
    const many = put(join(dir, 'many'), { 'skills/a/SKILL.md': 'x', 'skills/b/SKILL.md': 'y' });
    const empty = join(dir, 'empty');
    mkdirSync(empty);
    expect(await inspectInstallSource(one)).toEqual({ kind: 'skill' });
    expect(await inspectInstallSource(many)).toEqual({ kind: 'skill' });
    // 空文件夹也交给 skill.install 报“没有 Skills”。
    expect(await inspectInstallSource(empty)).toEqual({ kind: 'skill' });
  });
});

describe('inspectInstallSource：文件', () => {
  it('SKILL.md 是 Skills，其他文件不是来源', async () => {
    const skill = put(join(dir, 'a'), { 'SKILL.md': 'x', 'notes.md': 'x', 'readme.txt': 'x' });
    expect(await inspectInstallSource(join(skill, 'SKILL.md'))).toEqual({ kind: 'skill' });
    expect(await inspectInstallSource(join(skill, 'notes.md'))).toEqual({ kind: 'unsupported' });
    expect(await inspectInstallSource(join(skill, 'readme.txt'))).toEqual({
      kind: 'unsupported',
    });
  });

  it.skipIf(process.platform === 'win32')('符号链接不是来源', async () => {
    const real = put(join(dir, 'real'), { 'SKILL.md': 'x' });
    symlinkSync(real, join(dir, 'link'));
    expect(await inspectInstallSource(join(dir, 'link'))).toEqual({ kind: 'unsupported' });
  });

  it('路径要是绝对的、存在', async () => {
    await expect(inspectInstallSource('relative/path')).rejects.toThrow('absolute');
    await expect(inspectInstallSource(join(dir, 'missing'))).rejects.toThrow('ENOENT');
  });
});

describe('inspectInstallSource：ZIP', () => {
  it('根上有 wevir-plugin.json，清单存储或压缩都读得出', async () => {
    const manifest = JSON.stringify(MANIFEST);
    const stored = zipFile({ 'wevir-plugin.json': manifest, 'skills/a/SKILL.md': 'x' });
    const deflated = zipFile({ 'wevir-plugin.json': manifest }, ['wevir-plugin.json']);
    for (const path of [stored, deflated]) {
      expect(await inspectInstallSource(path)).toEqual({
        kind: 'plugin',
        format: 'wevir',
        manifest: MANIFEST,
      });
    }
  });

  it('只有一层外层文件夹时下移一层，目录条目也算', async () => {
    const wrapped = zipFile({
      'pkg/': '',
      'pkg/wevir-plugin.json': JSON.stringify(MANIFEST),
      'pkg/skills/a/SKILL.md': 'x',
    });
    expect(await inspectInstallSource(wrapped)).toMatchObject({ kind: 'plugin', format: 'wevir' });
    const claude = zipFile({ 'pkg/.claude-plugin/plugin.json': '{"name":"c"}' });
    expect(await inspectInstallSource(claude)).toEqual({ kind: 'plugin', format: 'claude' });
  });

  it('不止一个顶层条目时根不下移（同 Host 的 packageRoot）', async () => {
    const zip = zipFile({
      'pkg/wevir-plugin.json': JSON.stringify(MANIFEST),
      '__MACOSX/': '',
    });
    expect(await inspectInstallSource(zip)).toEqual({ kind: 'skill' });
    const hidden = zipFile({ '.git/config': 'x', 'wevir-plugin.json': JSON.stringify(MANIFEST) });
    expect(await inspectInstallSource(hidden)).toMatchObject({ kind: 'plugin', format: 'wevir' });
  });

  it('Claude 与 Codex 的包、只有标记目录的 ZIP', async () => {
    expect(
      await inspectInstallSource(zipFile({ '.codex-plugin/plugin.json': '{"name":"c"}' })),
    ).toEqual({ kind: 'plugin', format: 'codex' });
    expect(await inspectInstallSource(zipFile({ '.claude-plugin/': '', 'a.txt': 'x' }))).toEqual({
      kind: 'plugin',
      format: 'claude',
    });
  });

  it('没有清单的 ZIP 是 Skills', async () => {
    expect(await inspectInstallSource(zipFile({ 'SKILL.md': 'x' }))).toEqual({ kind: 'skill' });
    expect(await inspectInstallSource(zipFile({ 'my-skill/SKILL.md': 'x' }))).toEqual({
      kind: 'skill',
    });
  });

  it('清单太大或不是 JSON 时没有清单、仍是插件包', async () => {
    const broken = zipFile({ 'wevir-plugin.json': '{ nope' });
    const large = zipFile({
      'wevir-plugin.json': JSON.stringify({ x: 'a'.repeat(INSTALL_SOURCE_LIMITS.manifestBytes) }),
    });
    expect(await inspectInstallSource(broken)).toEqual({ kind: 'plugin', format: 'wevir' });
    expect(await inspectInstallSource(large)).toEqual({ kind: 'plugin', format: 'wevir' });
  });

  it('不是 ZIP 的 .zip 文件报错', async () => {
    const path = join(dir, 'fake.zip');
    writeFileSync(path, 'not a zip');
    await expect(inspectInstallSource(path)).rejects.toThrow();
  });
});

describe('readSkillFile', () => {
  it('读 SKILL.md 的文本', async () => {
    const root = put(join(dir, 's'), { 'SKILL.md': '---\nname: a\n---\n正文' });
    await expect(readSkillFile(join(root, 'SKILL.md'))).resolves.toBe('---\nname: a\n---\n正文');
  });

  it('只认名为 SKILL.md 的普通文件，要绝对路径，限制大小', async () => {
    const root = put(join(dir, 's'), {
      'SKILL.md': 'x',
      'other.md': 'x',
      'big/SKILL.md': 'a'.repeat(INSTALL_SOURCE_LIMITS.skillBytes + 1),
    });
    await expect(readSkillFile(join(root, 'other.md'))).rejects.toThrow('SKILL.md');
    await expect(readSkillFile('SKILL.md')).rejects.toThrow('absolute');
    await expect(readSkillFile(join(root, 'big', 'SKILL.md'))).rejects.toThrow('too large');
    mkdirSync(join(root, 'dir', 'SKILL.md'), { recursive: true });
    await expect(readSkillFile(join(root, 'dir', 'SKILL.md'))).rejects.toThrow('not a file');
    await expect(readSkillFile(join(root, 'gone', 'SKILL.md'))).rejects.toThrow('ENOENT');
  });
});
