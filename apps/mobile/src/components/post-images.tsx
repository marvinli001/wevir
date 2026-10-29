// 帖子里的图片：一排缩略图，用户的靠右、助理的靠左；按原图比例，最长边 `EDGE`。读的时候是占位底色，读不到时是一枚图片图标。

import type { UserImagePart } from '@wevir/protocol';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, View } from 'react-native';
import { t } from '../i18n';
import { useTheme } from '../theme';
import { Icon } from './ui';

const EDGE = 160;

export type LoadImage = (image: UserImagePart) => Promise<string>;

export function PostImages({
  images,
  align,
  load,
}: {
  images: readonly UserImagePart[];
  align: 'start' | 'end';
  load: LoadImage;
}) {
  return (
    <View
      style={[styles.row, { justifyContent: align === 'end' ? 'flex-end' : 'flex-start' }]}
      testID="post-images"
    >
      {images.map((image) => (
        <Thumb key={image.imageId} image={image} load={load} />
      ))}
    </View>
  );
}

function size(image: UserImagePart): { width: number; height: number } {
  const { width, height } = image;
  if (width === undefined || height === undefined) return { width: EDGE, height: EDGE };
  const scale = EDGE / Math.max(width, height);
  return {
    width: Math.max(48, Math.round(width * scale)),
    height: Math.max(48, Math.round(height * scale)),
  };
}

function Thumb({ image, load }: { image: UserImagePart; load: LoadImage }) {
  const theme = useTheme();
  const [uri, setUri] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    load(image).then(
      (value) => live && setUri(value),
      (error: unknown) => {
        console.warn('[wevir] could not load image', error);
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [image, load]);
  const box = [styles.thumb, size(image), { backgroundColor: theme.muted }];
  if (uri !== undefined && !failed) {
    return (
      <Image
        source={{ uri }}
        style={box}
        accessibilityLabel={image.name ?? t('bot.image')}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <View style={[box, styles.placeholder]} accessibilityLabel={image.name ?? t('bot.image')}>
      {failed ? (
        <Icon name={{ ios: 'photo', android: 'image' }} size={20} color={theme.mutedForeground} />
      ) : (
        <ActivityIndicator size="small" color={theme.mutedForeground} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  thumb: { borderRadius: 14, borderCurve: 'continuous' },
  placeholder: { alignItems: 'center', justifyContent: 'center' },
});
