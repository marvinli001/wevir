// Android 发行构建的签名（Expo config plugin，prebuild 时写进 android/app/build.gradle）。
//
// Expo 生成的 release 构建用 debug.keystore 签名，装不上已装的正式包、也不能发布。这里加一个 release 签名配置，在 Gradle 运行时读环境变量
// （scripts/android-release.sh 设置）：
//   WEVIR_ANDROID_KEYSTORE           PKCS#12 密钥库的路径
//   WEVIR_ANDROID_KEYSTORE_PASSWORD  密钥库与密钥的密码（同一个）
//   WEVIR_ANDROID_KEY_ALIAS          密钥别名，默认 `wevir`
// 没设密钥库时 release 仍用 debug 签名（本机试打包）。路径与密码不写进生成的文件。

const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '// wevir: release signing';

const SIGNING_CONFIG = `
        ${MARKER}
        release {
            def keystore = System.getenv('WEVIR_ANDROID_KEYSTORE')
            if (keystore) {
                storeFile file(keystore)
                storeType 'pkcs12'
                storePassword System.getenv('WEVIR_ANDROID_KEYSTORE_PASSWORD')
                keyAlias System.getenv('WEVIR_ANDROID_KEY_ALIAS') ?: 'wevir'
                keyPassword System.getenv('WEVIR_ANDROID_KEYSTORE_PASSWORD')
            }
        }`;

/** 在 `signingConfigs {` 里加 release，并让 release 构建类型在设了密钥库时用它。 */
function applySigning(gradle) {
  if (gradle.includes(MARKER)) return gradle;
  const signingConfigs = /signingConfigs\s*\{/;
  if (!signingConfigs.test(gradle))
    throw new Error('with-android-signing: no signingConfigs block');
  let out = gradle.replace(signingConfigs, (match) => `${match}${SIGNING_CONFIG}`);
  // buildTypes 里 release 的 `signingConfig signingConfigs.debug`（debug 构建类型的同一行在它前面，不动）。
  const release =
    /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/;
  if (!release.test(out))
    throw new Error('with-android-signing: release build type has no debug signingConfig');
  out = out.replace(
    release,
    "$1signingConfig System.getenv('WEVIR_ANDROID_KEYSTORE') ? signingConfigs.release : signingConfigs.debug",
  );
  return out;
}

module.exports = function withAndroidSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy')
      throw new Error('with-android-signing: build.gradle is not Groovy');
    cfg.modResults.contents = applySigning(cfg.modResults.contents);
    return cfg;
  });
};

module.exports.applySigning = applySigning;
