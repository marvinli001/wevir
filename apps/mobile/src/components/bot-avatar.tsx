// 助理的头像：bot-avatars 的小机器人画成 SVG（几何与颜色在 lib/bot-avatar.ts）。静止时一个姿势；工作中且允许动效时原地小跳，
// 落地压扁一下（库的 working 是 26 高、0.68 秒一跳，这里跳低一些，列表里不抢眼）；暂停时睡着。
//
// 画布比布局大一半、用负偏移收回来（同桌面），跳起来不被裁掉；身体在画布里往下偏 0.1（库的留白）。

import { useEffect, useId, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import Svg, { Defs, G, Path, RadialGradient, Stop } from 'react-native-svg';
import {
  AVATAR_COLORS,
  AVATAR_LIGHT,
  type Avatar,
  type AvatarPose,
  avatarGeometry,
  bodyColor,
  inkColor,
} from '../lib/bot-avatar';
import { useTheme } from '../theme';

const HOP_MS = 680;
const HOP_HEIGHT = 12;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => alive && setReduced(value))
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

export function BotAvatar({
  avatar,
  size = 44,
  pose = 'default',
  style,
}: {
  avatar: Avatar;
  size?: number;
  pose?: AvatarPose;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const reduced = useReducedMotion();
  const hopping = pose === 'working' && !reduced;
  const hop = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!hopping) {
      hop.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(hop, {
        toValue: 1,
        duration: HOP_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    // seed 错开起跳，一排工作中的头像不同步。
    const timer = setTimeout(() => loop.start(), avatar.seed * HOP_MS);
    return () => {
      clearTimeout(timer);
      loop.stop();
      hop.setValue(0);
    };
  }, [hopping, hop, avatar.seed]);

  const base = AVATAR_COLORS[theme.dark ? 'dark' : 'light'][avatar.color] ?? AVATAR_COLORS.light[0];
  const fill = bodyColor(base);
  const ink = inkColor(base);
  const geometry = avatarGeometry(avatar.type, pose);
  const { shadow, highlight } = AVATAR_LIGHT;
  const canvas = size * 1.5;
  const lift = (HOP_HEIGHT / 100) * size;
  // 一跳：起跳前与落地后各压扁一下，中间是抛物线。
  const translateY = hop.interpolate({
    inputRange: [0, 0.12, 0.25, 0.37, 0.5, 0.62, 0.74, 0.86, 1],
    outputRange: [0, 0, -0.55 * lift, -0.9 * lift, -lift, -0.9 * lift, -0.55 * lift, 0, 0],
  });
  const scaleY = hop.interpolate({
    inputRange: [0, 0.06, 0.12, 0.2, 0.86, 0.93, 1],
    outputRange: [1, 0.9, 1, 1.04, 1, 0.9, 1],
  });
  const scaleX = hop.interpolate({
    inputRange: [0, 0.06, 0.12, 0.2, 0.86, 0.93, 1],
    outputRange: [1, 1.08, 1, 0.97, 1, 1.08, 1],
  });

  return (
    <View
      style={[{ width: size, height: size }, style]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View
        style={[
          styles.canvas,
          {
            width: canvas,
            height: canvas,
            left: -size * 0.25,
            top: -size * 0.25,
            transform: hopping ? [{ translateY }, { scaleX }, { scaleY }] : [],
          },
        ]}
      >
        <Svg width={canvas} height={canvas} viewBox="-25 -25 150 150">
          <Defs>
            <RadialGradient
              id={`${id}shade`}
              cx={shadow.cx}
              cy={shadow.cy}
              r={shadow.r}
              gradientUnits="userSpaceOnUse"
            >
              {shadow.stops.map(([offset, opacity]) => (
                <Stop key={offset} offset={offset} stopColor="#000000" stopOpacity={opacity} />
              ))}
            </RadialGradient>
            <RadialGradient
              id={`${id}light`}
              cx={highlight.cx}
              cy={highlight.cy}
              r={highlight.r}
              gradientUnits="userSpaceOnUse"
            >
              {highlight.stops.map(([offset, opacity]) => (
                <Stop key={offset} offset={offset} stopColor="#ffffff" stopOpacity={opacity} />
              ))}
            </RadialGradient>
          </Defs>
          <G transform={`translate(0 ${10 + geometry.y}) rotate(${geometry.roll} 50 50)`}>
            {/* 底色、暗部、高光都填同一条路径（非零规则：云朵相交的圆取并集），不用裁剪：RNSVG 的 clipPath 按奇偶规则裁，
                云朵的重叠处会被挖掉。 */}
            <Path d={geometry.path} fill={fill} />
            <Path d={geometry.path} fill={`url(#${id}shade)`} />
            <Path d={geometry.path} fill={`url(#${id}light)`} />
            {geometry.eyes.map((eye) => (
              <G key={eye.x} transform={`translate(${eye.x} ${eye.y}) scale(${eye.sx} ${eye.sy})`}>
                <Path
                  d={eye.path}
                  stroke={ink}
                  strokeWidth={eye.width}
                  strokeLinecap="round"
                  fill="none"
                />
              </G>
            ))}
          </G>
        </Svg>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: { position: 'absolute' },
});
