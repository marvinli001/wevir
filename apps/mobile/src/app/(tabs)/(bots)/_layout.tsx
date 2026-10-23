// 标签页里自己的导航栈，只为了大标题与玻璃导航栏；详情页压在标签页之上（根布局）。

import { Stack } from 'expo-router';
import { stackOptions } from '../../../components/stack';
import { useTheme } from '../../../theme';

export default function Layout() {
  const theme = useTheme();
  return <Stack screenOptions={{ ...stackOptions(theme), headerLargeTitleEnabled: true }} />;
}
