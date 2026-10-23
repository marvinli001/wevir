// 助理的头像：与桌面子会话同一套 bot-avatars 小机器人（apps/desktop 的 session/avatar.ts），六种形状 × 六种颜色，浅色、深色各一组。
// 助理的头像在创建时随机抽一次，`{ type, color, seed }` 存在助理身上，手机照存的画。
//
// 画法照 bot-avatars 0.1.2 的静止姿势（`shading="smooth"`、饱和度 0.8，桌面的参数）：正面朝前时挤出的各层都被中间那层
// 盖住，看到的是底色的剪影，上面叠一层右侧的暗部与一层左侧的高光（都是径向渐变），再画一对眼睛。这里只算几何与颜色，
// 画在 components/bot-avatar.tsx。

import { AVATAR_SHAPES } from './bot-avatar-shapes';

export const AVATAR_TYPES = ['pebble', 'clover', 'drop', 'pill', 'circle', 'cloud'] as const;

export type AvatarType = (typeof AVATAR_TYPES)[number];

/** 浅色：褐、灰蓝、灰绿、灰粉、灰紫、麦黄；深色是各自亮一档。与桌面 avatar.ts 的 AVATAR_COLORS 相同（测试核对）。 */
export const AVATAR_COLORS = {
  light: ['#b59a6b', '#8e9fa3', '#a2ad95', '#bf9f98', '#9b98b0', '#c4b48e'],
  dark: ['#c9b083', '#9fb2b6', '#b2bda6', '#d2b0a8', '#aeabc4', '#d4c49e'],
} as const;

export interface Avatar {
  type: AvatarType;
  /** AVATAR_COLORS 里的序号，0 … 5。 */
  color: number;
  /** 0–1：错开动作的节拍，一排头像不同步。 */
  seed: number;
}

export type AvatarPose = 'default' | 'working' | 'sleeping';

export function randomAvatar(random: () => number = Math.random, avoid?: Avatar): Avatar {
  for (;;) {
    const avatar: Avatar = {
      type: AVATAR_TYPES[Math.floor(random() * AVATAR_TYPES.length)] ?? 'pebble',
      color: Math.floor(random() * AVATAR_COLORS.light.length),
      seed: Math.round(random() * 1000) / 1000,
    };
    // 换一个时至少形状或颜色要变。
    if (avoid === undefined || avatar.type !== avoid.type || avatar.color !== avoid.color) {
      return avatar;
    }
  }
}

/** 存下来的头像可能来自更新的 Host（多了形状或颜色）：认不出的退回第一种。 */
export function normalizeAvatar(avatar: Partial<Avatar> | undefined): Avatar {
  const type = AVATAR_TYPES.includes(avatar?.type as AvatarType)
    ? (avatar?.type as AvatarType)
    : 'pebble';
  const color =
    Number.isInteger(avatar?.color) &&
    (avatar?.color ?? -1) >= 0 &&
    (avatar?.color ?? 0) < AVATAR_COLORS.light.length
      ? (avatar?.color as number)
      : 0;
  const seed = Math.min(
    1,
    Math.max(0, Number.isFinite(avatar?.seed) ? (avatar?.seed as number) : 0),
  );
  return { type, color, seed };
}

type Rgb = readonly [number, number, number];

function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHsl([r, g, b]: Rgb): Rgb {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === rn
      ? (gn - bn) / d + (gn < bn ? 6 : 0)
      : max === gn
        ? (bn - rn) / d + 2
        : (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToHex([h, s, l]: Rgb): string {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    const x = ((t % 1) + 1) % 1;
    const v =
      x < 1 / 6
        ? p + (q - p) * 6 * x
        : x < 1 / 2
          ? q
          : x < 2 / 3
            ? p + (q - p) * (2 / 3 - x) * 6
            : p;
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(h + 1 / 3)}${channel(h)}${channel(h - 1 / 3)}`;
}

/** 身体的底色：库的 `saturation={0.8}` 把 HSL 饱和度减 0.1，亮度不变。 */
export function bodyColor(hex: string): string {
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  return hslToHex([h, Math.min(1, Math.max(0, s - 0.1)), l]);
}

/** 眼睛的墨色：底色很暗时用浅色，否则深色（库的规则；这十二种颜色都用深色）。 */
export function inkColor(hex: string): string {
  const linear = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexToRgb(bodyColor(hex));
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return luminance < 0.13 ? '#F7F5F2' : '#1E1A33';
}

const DEG = Math.PI / 180;

/** 库里各姿势的静止值：抬头、歪头、往下沉。 */
const POSES: Record<AvatarPose, { pitch: number; roll: number; y: number }> = {
  default: { pitch: 0, roll: 0, y: 0 },
  working: { pitch: 5 * DEG, roll: 0, y: 0 },
  sleeping: { pitch: -16 * DEG, roll: 6 * DEG, y: 3 },
};

export interface AvatarEye {
  /** 眼睛中心（形状的 100×100 坐标）。 */
  x: number;
  y: number;
  /** 投影到球面上的横向、纵向缩放。 */
  sx: number;
  sy: number;
  /** 以眼睛中心为原点的笔画路径与线宽。 */
  path: string;
  width: number;
}

export interface AvatarGeometry {
  path: string;
  /** 整体的旋转（度）与下沉（形状坐标）。 */
  roll: number;
  y: number;
  eyes: readonly AvatarEye[];
}

/** 五官贴在半径 30 的球面上：按头的俯仰投影（库的 La，静止时没有左右转头）。 */
function project(x: number, y: number, pitch: number) {
  const o = Math.asin(Math.max(-1, Math.min(1, x / 30)));
  const i = Math.asin(Math.max(-1, Math.min(1, -y / 30))) + pitch;
  const r = Math.cos(i);
  return { x: 30 * Math.sin(o) * r, y: -30 * Math.sin(i), sx: Math.cos(o), sy: r };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function avatarGeometry(type: AvatarType, pose: AvatarPose): AvatarGeometry {
  const shape = AVATAR_SHAPES[type];
  const { pitch, roll, y } = POSES[pose];
  // 睁眼是一笔竖着的圆头短线（宽 12.6），睡着是一道向下弯的弧线（宽 4），都是库在这些姿势下的取值。
  const open = pose !== 'sleeping';
  const eyePath = open ? 'M0 -1.1L0 1.1' : 'M-6 -0.9Q0 6.4 6 -0.9';
  const eyes = [-1, 1].map((side): AvatarEye => {
    const p = project(side * 12.5, 1, pitch);
    return {
      x: round(shape.faceX + p.x * shape.faceScale),
      y: round(shape.faceY + p.y * shape.faceScale),
      sx: round(Math.max(0.02, p.sx) * shape.faceScale),
      sy: round(Math.max(0.02, p.sy) * shape.faceScale),
      path: eyePath,
      width: open ? 12.6 : 4,
    };
  });
  return { path: shape.path, roll: roll / DEG, y, eyes };
}

/**
 * 光从左边来（库的 light 265°）：高光在左、暗部在右。坐标是形状的 100×100 坐标，`stops` 是 [位置, 不透明度]。
 * 暗部的内圆半径不为 0（库用两圆径向渐变），换算成单圆渐变的位置。
 */
export const AVATAR_LIGHT = (() => {
  const angle = 265 * DEG;
  const lx = Math.sin(angle);
  const ly = -Math.cos(angle);
  const spread = 1.55;
  const shadow = 0.34 * 0.35;
  const highlight = 0.22 * 1.3;
  const r0 = 4 * spread;
  const r1 = 84 * spread;
  const at = (t: number) => round((r0 + t * (r1 - r0)) / r1);
  return {
    shadow: {
      cx: round(50 - lx * 45),
      cy: round(50 - ly * 45),
      r: round(r1),
      stops: [
        [at(0), round(shadow)],
        [at(0.5), round(shadow * 0.35)],
        [1, 0],
      ] as const,
    },
    highlight: {
      cx: round(50 + lx * 37),
      cy: round(50 + ly * 37),
      r: round(62 * spread),
      stops: [
        [0, round(highlight)],
        [0.6, round(highlight * 0.23)],
        [1, 0],
      ] as const,
    },
  };
})();
