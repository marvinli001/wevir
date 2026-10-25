# Wevir · Stripe 与 X 品牌资源

[预览与裁切示意](preview/social/index.html) · [尺寸、文件大小与 SHA-256](social-manifest.json)

延续现有「共核」主标与转曲 Wevir 字标。主版为金色主标 / 灰调象牙白 `#F4F3ED`，深色备选为铂金 / 石墨黑。头像只保留主标，不放小字；完整方形画布适合平台施加圆形裁切，主标位于中心安全圆内。

## 直接上传

| 用途 | 推荐文件 | 规格 |
| --- | --- | --- |
| Stripe 公司头像 / 品牌 icon | [company-avatar-512.png](exports/social/stripe/light/company-avatar-512.png) | 512 × 512，PNG |
| X 官号头像 | [avatar-400.png](exports/social/x/light/avatar-400.png) | 400 × 400，PNG |
| X 官号横幅 | [header-1500x500.png](exports/social/x/light/header-1500x500.png) | 1500 × 500，PNG |

各目录的 `dark/` 是深色备选，不会随 Stripe / X 的界面主题自动切换。另有 1024px 头像源图、JPG 横幅、3000 × 1000px 高分辨率横幅。所有 PNG/JPG 均从对应 SVG 导出，SVG 在 `svg/social/`；字标和文案均已转曲，无需安装字体。

横幅文案为 `Local-first AI agent workspace.` 与 `wevir.si`。文字与前景主标避开左下角头像重叠区域，并位于上下各裁切 60px 后仍可见的区域。预览页的圆形头像、遮挡与裁切均是示意，没有绑定账号或虚构账号名、认证状态、关注数。

## 平台规格

- [Stripe 品牌图片要求](https://docs.stripe.com/receipts#image-requirements)：方形，至少 128 × 128px，支持 PNG/JPG，最大 512KB。本套 Stripe 头像均小于 500KB。
- [X 头像与横幅尺寸](https://help.x.com/en/managing-your-account/how-to-customize-your-profile)：头像推荐 400 × 400px，横幅推荐 1500 × 500px。
- [X 上传与裁切说明](https://help.x.com/en/managing-your-account/common-issues-when-uploading-profile-photo)：头像上限 2MB，横幅在不同显示环境下可能裁掉顶部和底部各 60px。本套上传版均小于 2MB。

规范核对日期：2026-10-25。Stripe 文档通过官方 CLI `stripe docs /receipts` 读取；没有读取或修改 Stripe 账户数据。

## 重建与打包

在 Wevir 仓库根目录执行：

```bash
pnpm icons:social
pnpm icons:check
pnpm icons:pack --social
```

输出 `release/wevir-social-v1.zip` 与同名 `.sha256`。ZIP 内有上传图片、SVG 源文件、字体与许可证、文案路径和预览；不包含应用代码或账户凭据。正常重建使用已提交的转曲数据；修改文案时，可选安装 `fonttools==4.60.1` 后运行 `python3 scripts/icons/outline-social.py`，再重建。

头像安全圆、横幅内容区域、图片尺寸、RGB/无透明通道及文件大小在导出时校验；文件摘要和矢量来源由 `icons:check` 复查。未上传到 Stripe 或 X。
