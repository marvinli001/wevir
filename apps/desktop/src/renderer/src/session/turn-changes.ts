// 回合下面的“N 个文件已更改”打开“变更”窗格到这个回合（0.20.0，desktop-layout.md §18）。主会话的会话视图在 Host 有
// `workspace_diff` 时提供；没有时（子智能体详情、支线窗格、旧的 Host）照旧展开这个回合的过程。

import type { TurnId } from '@wevir/protocol';
import { createContext } from 'react';

export const OpenTurnChanges = createContext<((turnId: TurnId) => void) | undefined>(undefined);
