import { existsSync, readFileSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESOURCES_DIR_ENV } from './paths.js';

// Wevir 自己的提示词（prompts/，ADR-0005 补记 2）的加载与渲染。模板语法见 prompts/README.md「模板语法」：
// 1. 先删除所有 HTML 注释；2. `{{> 路径 }}` 引入另一个文件（路径相对 prompts/，同样先删注释）；
// 3. `{{ 变量 }}` 替换成变量的值，变量缺失时报错；4. 渲染结果里不得残留 `{{`（Codex 自己也用 `{{ }}` 作模板变量）。

/**
 * 提示词目录：仓库根的 `prompts/`。`src/` 与 `dist/` 都在包目录下一层，所以同一个相对路径对两者都成立。
 * 安装包里的位置见 `resolvePromptsDir`。
 */
export function defaultPromptsDir(): string {
  return fileURLToPath(new URL('../../../prompts/', import.meta.url));
}

/**
 * 找提示词目录：应用资源目录（`WEVIR_RESOURCES_DIR` 的 `prompts/`，安装包随附的那份，
 * apps/desktop/scripts/stage-resources.ts 准备）→ 仓库的 `prompts/`。与 `resolveCodexBinary` 的顺序相同；
 * 资源目录里没有 prompts/ 时（开发构建上只放了二进制）用仓库的。
 */
export function resolvePromptsDir(
  env: NodeJS.ProcessEnv = process.env,
  fallback: string = defaultPromptsDir(),
): string {
  const resourcesDir = env[RESOURCES_DIR_ENV];
  if (resourcesDir !== undefined && resourcesDir !== '') {
    const dir = join(resourcesDir, 'prompts');
    if (existsSync(join(dir, 'base.md'))) return dir;
  }
  return fallback;
}

/** `base.md` 的变量（prompts/README.md「变量」）。 */
export interface BasePromptVars {
  /** 模型的显示名，来自 Provider 的模型列表。 */
  model_display_name: string;
  /** Provider 的显示名。 */
  provider_display_name: string;
}

const COMMENT = /<!--[\s\S]*?-->/g;
const INCLUDE = /\{\{>\s*([^\s}]+)\s*\}\}/g;
const VARIABLE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
/** 引入的嵌套上限，防止循环引入。 */
const MAX_INCLUDE_DEPTH = 8;

/**
 * 渲染一个提示词模板。`read(path)` 读 prompts/ 下相对路径的文件（引入时用）。结果去掉开头的空行（文件头的注释
 * 删掉之后留下的）。不合法时抛错：引入越出 prompts/、变量缺失、残留 `{{`。
 */
export function renderPromptTemplate(
  source: string,
  vars: Readonly<Record<string, string>>,
  read: (path: string) => string,
  depth = 0,
): string {
  if (depth > MAX_INCLUDE_DEPTH) throw new Error('提示词引入的层数太多（循环引入？）');
  let text = source.replace(COMMENT, '');
  text = text.replace(INCLUDE, (_, path: string) =>
    renderPromptTemplate(read(path), vars, read, depth + 1),
  );
  text = text.replace(VARIABLE, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`提示词变量 ${name} 没有值`);
    return value;
  });
  if (depth === 0 && text.includes('{{')) {
    throw new Error('提示词渲染结果里残留了 {{（prompts/README.md 模板语法第 4 条）');
  }
  return depth === 0 ? text.replace(/^\s*\n/, '') : text;
}

/** 读 prompts/ 下的文件；路径越出 prompts/ 时抛错。 */
export function promptReader(dir: string): (path: string) => string {
  const root = resolve(dir);
  return (path) => {
    const full = resolve(root, normalize(path));
    if (full !== root && !full.startsWith(root + sep)) {
      throw new Error(`提示词引入越出了 prompts/：${path}`);
    }
    return readFileSync(full, 'utf8');
  };
}

/**
 * 渲染 `base.md`（经网关的第三方模型的基础提示词，ADR-0005 补记 2），写进模型目录的 `base_instructions` 与
 * `thread/start` 的 `baseInstructions`。同一个目录的 `base.md` 只读一次。
 */
export class BasePrompt {
  readonly #read: (path: string) => string;
  #source: string | undefined;
  #planMode: string | undefined;

  constructor(dir: string = defaultPromptsDir()) {
    this.#read = promptReader(dir);
  }

  render(vars: BasePromptVars): string {
    this.#source ??= this.#read('base.md');
    return renderPromptTemplate(this.#source, { ...vars }, this.#read);
  }

  /**
   * 计划模式的说明（`plan-mode.md`，0.36.0，ADR-0005 补记 16）：经网关的第三方模型在计划模式的回合里作为协作模式的
   * `developer_instructions` 下发。没有变量；只读、只渲染一次。
   */
  planMode(): string {
    this.#planMode ??= renderPromptTemplate(this.#read('plan-mode.md'), {}, this.#read);
    return this.#planMode;
  }
}

/** 仓库里 `base.md` 的路径（文档与测试用）。 */
export function basePromptPath(dir: string = defaultPromptsDir()): string {
  return join(dir, 'base.md');
}
