// 来源 https://github.com/kuratlielia/arc-library/blob/8302b52ed9dc79ae7ca699b158a98dfdf09656f7/registry/motion-tokens.ts
// 来源提交 8302b52ed9dc79ae7ca699b158a98dfdf09656f7 · MIT License · Copyright (c) 2026 Elia Kuratli
/** CSS 的 linear() 由 spring-easing.ts 从同一组参数生成。 */
export const motionTokens = {
  duration: { instant: 0.12, fast: 0.16, standard: 0.24, considered: 0.48 },
  ease: { enter: [0.16, 1, 0.3, 1], standard: [0.22, 1, 0.36, 1] },
  spring: {
    press: { stiffness: 520, damping: 44, mass: 1 },
    reveal: { stiffness: 340, damping: 34, mass: 1 },
    snap: { stiffness: 800, damping: 60, mass: 1 },
    bounce: { stiffness: 380, damping: 18, mass: 1 },
  },
} as const;
