# 模型服务的标志

首次引导与 Provider 列表（`components/provider-logo.tsx`）用的标志，原样取自 [lobehub/lobe-icons](https://github.com/lobehub/lobe-icons) 的 npm 包 `@lobehub/icons-static-svg@1.95.1`（`icons/` 目录），文件内容未改（下面注明的浅色版除外）。许可证 MIT，`Copyright (c) 2023 LobeHub`，署名在仓库根目录的 `NOTICE` 第 9 节。各标志是对应公司的商标，只用来指认服务。

| 文件 | 用于 | sha256 |
|---|---|---|
| `openai.svg` | OpenAI | `a595df6b423920c67a7f8f73c063e4bfb72d415948097b6cac063a2366bb5186` |
| `anthropic.svg` | Anthropic | `e833fdfa7e7187a86a05b870925067556a506dcd4239089aed73e1e58c9366a3` |
| `gemini-color.svg` | Google AI Studio | `8ab0a9bafec11f7e69bcb9fc4ffd8f1bc927d1ddcbbb6ff36dee5ae8b5a9d602` |
| `azure-color.svg` | Azure OpenAI / Azure Claude | `abc639d094593943c1b201270f4903c74d02d2e26acf26abf592a29c222c5181` |
| `vertexai-color.svg` | Google Vertex AI | `40f8bb6f7aca8d80ce2b0bd0d976e8e3ddeada3719758d262ea20075c11ad764` |
| `deepseek-color.svg` | DeepSeek | `deba5f98a5c1796e20fcac3149bcd7eb8a32f0bdd04d048819400b1f28bd1439` |
| `qwen-color.svg` | 通义千问 | `77f5768c66d08ce1d3d14e73373975c1bc0454be88c81523ddd0ffd7e2974029` |
| `kimi-color.svg` | Kimi | `74a7292aeb0220445d14c5d397d75760e2e8c6ed6a9e5fe4f3023471bf62a9ff` |
| `kimi-color-light.svg` | Kimi（浅色主题） | `fb386854f341fa4d03ffcc21827eee59ae72ec9bb0542479177ce20ae619ddfb` |
| `zai.svg` | Z.ai | `e748cb5108ce37b116d7a5ba97d37e0ae97eadf6849b0de11afb248e244a01e1` |
| `zhipu-color.svg` | 智谱 GLM | `8174e65ff71647d5c705c920c953a82bd723d9e3e42887bdd4ffc9dfe51207a0` |
| `xiaomimimo.svg` | 小米 MiMo | `b04ad7dad52af2212c4567daf0ee6856f2c4625c92c680a27f9880295d558b71` |
| `xai.svg` | SpaceXAI（原 xAI；保留旧标志） | `89eb7de9f0d02a41cfecd9109e253d7fd3529e27467dee4254faa67f3ac21451` |
| `ollama.svg` | Ollama | `3a268218fb2e6e81fa31df70f70b51331625047794db81db21d35359428fae7a` |
| `codex-color.svg` | 订阅来源 Codex（ChatGPT 订阅） | `4a2f43ce46b5b6e3722c95088f88d26ef91e6a8c2e598e70642a1c54367386e4` |
| `claude-color.svg` | 订阅来源 Claude Agent | `a3101f3047a119aa11825ad9369510f0c472428c8c52d420e31bc62db44a8364` |
| `cursor.svg` | 订阅来源 Cursor | `0cb51bddf264ae108926fd554c063ef40fc1aac3c5c921ddb39ad184e4e5d0ef` |
| `opencode.svg` | 订阅来源 OpenCode | `7cfa6e9d6726f7c9fa26c7d9aef0dfec52d20a137380454340f30f12ccbfd302` |
| `grok.svg` | 订阅来源 Grok | `9175fc90c22655160231976c849f25a03b888d7cc0e04c5f1b987b659bb07c95` |
| `codebuddy-color.svg` | 订阅来源 WorkBuddy（CodeBuddy CLI） | `033d5da624460e686046f22b4e242b6b86484ad84ec4877e4efa15a9fb642b97` |
| `antigravity-color.svg` | 订阅来源 Antigravity | `652128cf55a28bb958563ee372d0bd00208d9e6fd446f523f77aafd811eef8ca` |

订阅来源的标志（0.19.0）是软件本身的标志（Claude 用 Claude 的标志，不用 Claude Code 的，照 Anthropic 对第三方的品牌要求）。

单色的（`fill="currentColor"`）经 CSS 遮罩画成文字色，彩色的（`-color`）用 `<img>` 原样显示。

`kimi-color-light.svg` 是唯一改过的文件：由 `kimi-color.svg` 把 K 字的 `fill="#fff"` 改成 `#000`，其余不变；原图的 K 是白色，浅色主题下看不见。
