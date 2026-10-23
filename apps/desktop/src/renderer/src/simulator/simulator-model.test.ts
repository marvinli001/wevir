import type { SimulatorDevice } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { formatShortcut } from '@/lib/shortcuts';
import {
  avcCodecString,
  captureFileName,
  defaultDevice,
  defaultNewDevice,
  deviceGroups,
  fitScale,
  formatDuration,
  mirrorPoint,
  namedKeyInput,
  pointsOf,
  SIMULATOR_SHORTCUTS,
  sideButtons,
  toDevicePoint,
  zoomIn,
  zoomOut,
} from './simulator-model';

function device(patch: Partial<SimulatorDevice>): SimulatorDevice {
  return {
    udid: 'A',
    name: 'iPhone 17 Pro',
    platform: 'ios',
    runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    osVersion: '26.5',
    family: 'iphone',
    state: 'shutdown',
    available: true,
    attachedBy: [],
    ...patch,
  };
}

describe('设备分组与默认设备', () => {
  const devices = [
    device({ udid: 'BOOTED', state: 'booted' }),
    device({ udid: 'AGENT', state: 'booted', attachedBy: ['ses_abc'] }),
    device({ udid: 'OFF' }),
    device({ udid: 'GONE', available: false }),
  ];

  it('已启动的一组，可启动的一组（运行时不在了的不列）', () => {
    const groups = deviceGroups(devices);
    expect(groups.booted.map((entry) => entry.udid)).toEqual(['BOOTED', 'AGENT']);
    expect(groups.available.map((entry) => entry.udid)).toEqual(['OFF']);
  });

  it('优先 agent 在这个会话里 attach 过的，否则第一台已启动的', () => {
    expect(defaultDevice(devices, 'ses_abc')?.udid).toBe('AGENT');
    expect(defaultDevice(devices, 'ses_other')?.udid).toBe('BOOTED');
    expect(defaultDevice([device({ udid: 'OFF' })], undefined)).toBeUndefined();
  });

  it('新增模拟器默认第一个 iPhone（不是 iPod）与最新的 iOS 运行时', () => {
    expect(
      defaultNewDevice(
        [
          { id: 'ipad', name: 'iPad Air', family: 'ipad' },
          { id: 'new', name: 'iPhone 17 Pro', family: 'iphone' },
          { id: 'old', name: 'iPhone 16', family: 'iphone' },
          { id: 'ipod', name: 'iPod touch (7th generation)', family: 'iphone' },
        ],
        [
          { id: 'r9', name: 'iOS 9.3', platform: 'ios', version: '9.3', available: true },
          { id: 'r26', name: 'iOS 26.5', platform: 'ios', version: '26.5', available: true },
          { id: 'r27', name: 'iOS 27.0', platform: 'ios', version: '27.0', available: false },
        ],
      ),
    ).toEqual({ deviceTypeId: 'new', runtimeId: 'r26', name: 'iPhone 17 Pro' });
    expect(defaultNewDevice([], [])).toBeUndefined();
  });
});

describe('指针与按键', () => {
  const screen = { width: 402, height: 874 };
  const rect = { left: 100, top: 50, width: 201, height: 437 };

  it('元素上的位置按比例换算成点，夹在屏幕内', () => {
    expect(toDevicePoint({ x: 200.5, y: 268.5 }, rect, screen)).toEqual({ x: 201, y: 437 });
    expect(toDevicePoint({ x: 0, y: 1000 }, rect, screen)).toEqual({ x: 0, y: 874 });
  });

  it('第二根手指以屏幕中心对称', () => {
    expect(mirrorPoint({ x: 100, y: 200 }, screen)).toEqual({ x: 302, y: 674 });
  });

  it('命名键转成设备按键，带 ⌘ / ⌃ 的与可打印字符不转', () => {
    expect(namedKeyInput({ key: 'Enter', metaKey: false, ctrlKey: false })).toEqual({
      type: 'key',
      key: 'return',
    });
    expect(namedKeyInput({ key: 'Backspace', metaKey: false, ctrlKey: false })).toEqual({
      type: 'key',
      key: 'delete',
    });
    expect(namedKeyInput({ key: 'ArrowLeft', metaKey: true, ctrlKey: false })).toBeUndefined();
    expect(namedKeyInput({ key: 'a', metaKey: false, ctrlKey: false })).toBeUndefined();
  });

  it('窗格快捷键的写法', () => {
    expect(formatShortcut(SIMULATOR_SHORTCUTS.home, true)).toBe('⇧⌘H');
    expect(formatShortcut(SIMULATOR_SHORTCUTS.rotateRight, true)).toBe('⌘→');
    expect(formatShortcut(SIMULATOR_SHORTCUTS.zoomIn, true)).toBe('⌘+');
    expect(formatShortcut(SIMULATOR_SHORTCUTS.zoomOut, true)).toBe('⌘-');
    expect(formatShortcut(SIMULATOR_SHORTCUTS.actualSize, true)).toBe('⌘1');
  });
});

describe('缩放与外框', () => {
  it('放大缩小走档位，从适应窗格的任意比例接上', () => {
    expect(zoomIn(1)).toBe(1.25);
    expect(zoomIn(0.6)).toBe(0.67);
    expect(zoomIn(3)).toBe(3);
    expect(zoomOut(1)).toBe(0.75);
    expect(zoomOut(0.6)).toBe(0.5);
    expect(zoomOut(0.25)).toBe(0.25);
  });

  it('适应窗格让整台设备放得下，最大 3 倍', () => {
    expect(fitScale({ width: 430, height: 1000 }, { width: 402, height: 874 }, 14)).toBe(1);
    expect(fitScale({ width: 5000, height: 5000 }, { width: 402, height: 874 }, 14)).toBe(3);
    expect(fitScale({ width: 0, height: 0 }, { width: 402, height: 874 }, 14)).toBe(1);
  });

  it('像素按倍率换成点', () => {
    expect(pointsOf({ width: 1206, height: 2622 }, 3)).toEqual({ width: 402, height: 874 });
  });

  it('侧键随方向转到别的边，iPad 不画', () => {
    expect(sideButtons('iphone', 'portrait').map((button) => button.edge)).toEqual([
      'left',
      'left',
      'left',
      'right',
    ]);
    const left = sideButtons('iphone', 'landscapeLeft');
    expect(left.map((button) => button.edge)).toEqual(['bottom', 'bottom', 'bottom', 'top']);
    expect(left[0]?.start).toBe(0.17);
    const right = sideButtons('iphone', 'landscapeRight');
    expect(right.map((button) => button.edge)).toEqual(['top', 'top', 'top', 'bottom']);
    expect(right[3]?.start).toBeCloseTo(0.63);
    expect(sideButtons('ipad', 'portrait')).toEqual([]);
  });
});

describe('其他', () => {
  it('avcC 的 profile、约束与 level 拼成 codec 字符串', () => {
    expect(avcCodecString(new Uint8Array([1, 0x64, 0x00, 0x33, 0xff]))).toBe('avc1.640033');
  });

  it('文件名不带冒号与斜杠', () => {
    expect(captureFileName('iPhone 17 Pro', new Date(2026, 9, 24, 9, 5, 7), 'png')).toBe(
      'Simulator iPhone 17 Pro 2026-10-24 09.05.07.png',
    );
    expect(captureFileName('a/b:c', new Date(2026, 0, 1), 'mp4')).toBe(
      'Simulator a-b-c 2026-01-01 00.00.00.mp4',
    );
  });

  it('录制时长 m:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65_400)).toBe('1:05');
  });
});
