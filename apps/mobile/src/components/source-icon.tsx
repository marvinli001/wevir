import type { ProviderProfile } from '@wevir/protocol';
import { Image, type ImageSourcePropType, Text } from 'react-native';

const LOGOS: Record<string, { image: ImageSourcePropType; mono?: true }> = {
  chatgpt: { image: require('../../assets/source-logos/chatgpt.png') },
  claude: { image: require('../../assets/source-logos/claude.png') },
  cursor: { image: require('../../assets/source-logos/cursor.png'), mono: true },
  opencode: { image: require('../../assets/source-logos/opencode.png'), mono: true },
  workbuddy: { image: require('../../assets/source-logos/workbuddy.png') },
  grok: { image: require('../../assets/source-logos/grok.png'), mono: true },
  antigravity: { image: require('../../assets/source-logos/antigravity.png') },
  devin: { image: require('../../assets/source-logos/devin.png') },
  copilot: { image: require('../../assets/source-logos/copilot.png'), mono: true },
  kiro: { image: require('../../assets/source-logos/kiro.png') },
};

export function SourceIcon({
  provider,
  color,
}: {
  provider: ProviderProfile | undefined;
  color: string;
}) {
  const logo = provider && LOGOS[provider.kind];
  return logo ? (
    <Image
      source={logo.image}
      style={{ width: 16, height: 16, ...(logo.mono && { tintColor: color }) }}
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  ) : (
    <Text style={{ width: 16, fontSize: 12, fontWeight: '600', color }}>
      {provider?.displayName.trim().charAt(0).toUpperCase() ?? '?'}
    </Text>
  );
}
