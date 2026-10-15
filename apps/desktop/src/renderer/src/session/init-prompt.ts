// SPDX-License-Identifier: Apache-2.0
// 移植自 openai/codex codex-rs/tui/assets/prompt_for_init_command.md
// 来源提交 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d（rust-v0.162.1）
// Copyright 2025 OpenAI
// 修改：英文照原文；另写一份中文（界面是中文时用），结构与要求不变，补了一句“已有 AGENTS.md 时不改”的结果说明。
//
// 斜杠命令 `/init`（U33）：让 Agent 给当前仓库写一份 AGENTS.md。作为一条普通消息发出（与 Codex 的终端界面一样）。

const ENGLISH = `Generate a file named AGENTS.md that serves as a contributor guide for this repository.
Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it.
Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed — add sections if relevant, and omit those that do not apply to this project.

Document Requirements

- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections

Project Structure & Module Organization

- Outline the project structure, including where the source code, tests, and assets are located.

Build, Test, and Development Commands

- List key commands for building, testing, and running locally (e.g., npm test, make build).
- Briefly explain what each command does.

Coding Style & Naming Conventions

- Specify indentation rules, language-specific style preferences, and naming patterns.
- Include any formatting or linting tools used.

Testing Guidelines

- Identify testing frameworks and coverage requirements.
- State test naming conventions and how to run tests.

Commit & Pull Request Guidelines

- Summarize commit message conventions found in the project’s Git history.
- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).

(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.`;

const CHINESE = `为这个仓库生成一份名为 AGENTS.md 的贡献者指南。
动手之前先看当前工作目录里是否已经有 AGENTS.md；有的话不要覆盖或修改它，只告诉我已经存在。
目标是一份清楚、简洁、结构分明的文档：每节有说明性的标题，内容可以照着做。
按下面的提纲写，但要按项目调整：相关的就加节，不适用的就省略。

文档要求

- 文档标题用“仓库指南”。
- 用 Markdown 标题（#、## 等）组织结构。
- 保持简短，200–400 字为宜。
- 说明要短、直接，针对这个仓库。
- 需要时给出例子（命令、目录路径、命名模式）。
- 语气专业，以指导为主。

建议的小节

项目结构与模块组织

- 概述项目结构，包括源码、测试与资源文件各在哪里。

构建、测试与开发命令

- 列出构建、测试与本地运行的关键命令（例如 npm test、make build）。
- 简要说明每条命令做什么。

代码风格与命名约定

- 写明缩进规则、语言相关的风格偏好与命名模式。
- 列出用到的格式化与 lint 工具。

测试指南

- 写明测试框架与覆盖率要求。
- 写明测试的命名约定与运行方法。

提交与 Pull Request 指南

- 总结项目 Git 历史里的提交信息约定。
- 列出 Pull Request 的要求（说明、关联的 issue、截图等）。

（可选）有需要时加别的小节，例如安全与配置提示、架构概览或给 Agent 的说明。`;

/** `/init` 发出的消息：界面是中文时用中文，否则用英文。 */
export function initPrompt(locale: string): string {
  return locale.startsWith('zh') ? CHINESE : ENGLISH;
}
