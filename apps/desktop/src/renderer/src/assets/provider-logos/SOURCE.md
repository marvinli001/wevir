# 模型服务的标志

首次引导与 Provider 列表（`components/provider-logo.tsx`）用的标志，原样取自 [lobehub/lobe-icons](https://github.com/lobehub/lobe-icons) 的 npm 包 `@lobehub/icons-static-svg@1.95.1`（`icons/` 目录），文件内容未改。许可证 MIT，`Copyright (c) 2023 LobeHub`，署名在仓库根目录的 `NOTICE` 第 9 节。各标志是对应公司的商标，只用来指认服务。

| 文件 | 用于 | sha256 |
|---|---|---|
| `openai.svg` | OpenAI | `a595df6b423920c67a7f8f73c063e4bfb72d415948097b6cac063a2366bb5186` |
| `anthropic.svg` | Anthropic | `e833fdfa7e7187a86a05b870925067556a506dcd4239089aed73e1e58c9366a3` |
| `gemini-color.svg` | Google AI Studio | `8ab0a9bafec11f7e69bcb9fc4ffd8f1bc927d1ddcbbb6ff36dee5ae8b5a9d602` |
| `vertexai-color.svg` | Google Vertex AI | `40f8bb6f7aca8d80ce2b0bd0d976e8e3ddeada3719758d262ea20075c11ad764` |
| `deepseek-color.svg` | DeepSeek | `deba5f98a5c1796e20fcac3149bcd7eb8a32f0bdd04d048819400b1f28bd1439` |
| `qwen-color.svg` | 通义千问 | `77f5768c66d08ce1d3d14e73373975c1bc0454be88c81523ddd0ffd7e2974029` |
| `kimi-color.svg` | Kimi | `74a7292aeb0220445d14c5d397d75760e2e8c6ed6a9e5fe4f3023471bf62a9ff` |
| `zhipu-color.svg` | 智谱 GLM | `8174e65ff71647d5c705c920c953a82bd723d9e3e42887bdd4ffc9dfe51207a0` |
| `xai.svg` | xAI | `89eb7de9f0d02a41cfecd9109e253d7fd3529e27467dee4254faa67f3ac21451` |
| `ollama.svg` | Ollama | `3a268218fb2e6e81fa31df70f70b51331625047794db81db21d35359428fae7a` |

单色的（`fill="currentColor"`）经 CSS 遮罩画成文字色，彩色的（`-color`）用 `<img>` 原样显示。
