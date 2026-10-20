import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  finishInstallTiming,
  INSTALL_TIMING_LOG,
  markInstallTiming,
  PENDING_INSTALL_FILE,
  startInstallTiming,
} from './install-timing.js';

describe('install timing', () => {
  let dir: string;
  let file: string;
  let logFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wevir-install-timing-'));
    file = join(dir, 'desktop', PENDING_INSTALL_FILE);
    logFile = join(dir, 'logs', INSTALL_TIMING_LOG);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const T = 1_800_000_000_000;

  it('旧版本记下的时间点与新版本启动的时间点合成一行', () => {
    startInstallTiming(file, { from: '0.1.0', to: '0.2.0', platform: 'win32', clickedAt: T });
    markInstallTiming(file, 'hostStoppedAt', T + 40);
    markInstallTiming(file, 'installerAt', T + 45);
    markInstallTiming(file, 'quitAt', T + 300);
    const timing = finishInstallTiming({
      file,
      logFile,
      currentVersion: '0.2.0',
      marks: {
        processAt: T + 20_300,
        readyAt: T + 20_800,
        windowAt: T + 21_500,
        hostAt: T + 22_000,
      },
      now: T + 22_000,
    });
    expect(timing).toMatchObject({
      from: '0.1.0',
      to: '0.2.0',
      installed: true,
      ms: {
        hostStop: 40,
        toInstaller: 45,
        toQuit: 300,
        install: 20_000,
        appReady: 500,
        window: 1200,
        host: 1700,
        total: 21_500,
      },
    });
    expect(JSON.parse(readFileSync(logFile, 'utf8'))).toEqual(timing);
    expect(existsSync(file)).toBe(false);
    // 读过就删掉：再次启动不再记。
    expect(
      finishInstallTiming({
        file,
        logFile,
        currentVersion: '0.2.0',
        marks: { processAt: T },
        now: T,
      }),
    ).toBeUndefined();
  });

  it('没装上记 installed: false；缺的时间点不出对应的段', () => {
    startInstallTiming(file, { from: '0.1.0', to: '0.2.0', platform: 'darwin', clickedAt: T });
    const timing = finishInstallTiming({
      file,
      logFile,
      currentVersion: '0.1.0',
      marks: { processAt: T + 5000, windowAt: T + 6000 },
      now: T + 6000,
    });
    expect(timing?.installed).toBe(false);
    expect(timing?.ms).toEqual({ window: 1000, total: 6000 });
  });

  it('没有记录、过期或内容不对时不记，并删掉文件', () => {
    const finish = () =>
      finishInstallTiming({
        file,
        logFile,
        currentVersion: '0.2.0',
        marks: { processAt: T },
        now: T + 2 * 60 * 60 * 1000,
      });
    expect(finish()).toBeUndefined();
    startInstallTiming(file, { from: '0.1.0', to: '0.2.0', platform: 'win32', clickedAt: T });
    expect(finish()).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    startInstallTiming(file, { from: '0.1.0', to: '0.2.0', platform: 'win32', clickedAt: T });
    writeFileSync(file, '{not json');
    expect(finish()).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(logFile)).toBe(false);
    // 没有记录时 markInstallTiming 什么也不做。
    markInstallTiming(file, 'quitAt', T);
    expect(existsSync(file)).toBe(false);
  });
});
