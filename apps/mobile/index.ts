// 入口：先装运行时缺的东西（`crypto.getRandomValues` 等，@noble/* 与 @wevir/noise 要用），再交给 expo-router。
import './src/lib/polyfills';
// 收静默推送的后台任务要在模块顶层定义（App 没开、由推送唤起时也要跑到）。
import './src/lib/push-native';
import 'expo-router/entry';
