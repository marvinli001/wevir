// 入口：先装运行时缺的东西（`crypto.getRandomValues` 等，@noble/* 与 @wevir/noise 要用），再交给 expo-router。
import './src/lib/polyfills';
import 'expo-router/entry';
