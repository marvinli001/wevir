// 自动化模板（照 Claude 的 Scheduled tasks → Templates）：标题、一句话的用途、发给 Agent 的指令与默认计划。点模板打开新建对话框，
// 字段都填好，用户再改。指令是发给模型的（i18n 的 `automations.template.*.prompt`），按界面语言写。

import type { AutomationSchedule } from '@wevir/protocol';
import {
  BugOff,
  GitPullRequest,
  type LucideIcon,
  Newspaper,
  PackageCheck,
  ScrollText,
  Sunrise,
} from 'lucide-react';
import { type PlainMessageKey, t } from '@/i18n';

export interface AutomationTemplate {
  id: string;
  icon: LucideIcon;
  title: PlainMessageKey;
  summary: PlainMessageKey;
  prompt: PlainMessageKey;
  schedule: AutomationSchedule;
}

export const TEMPLATES: readonly AutomationTemplate[] = [
  {
    id: 'standup',
    icon: Sunrise,
    title: 'automations.template.standup.title',
    summary: 'automations.template.standup.summary',
    prompt: 'automations.template.standup.prompt',
    schedule: { kind: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5] },
  },
  {
    id: 'ci',
    icon: BugOff,
    title: 'automations.template.ci.title',
    summary: 'automations.template.ci.summary',
    prompt: 'automations.template.ci.prompt',
    schedule: { kind: 'daily', time: '08:30' },
  },
  {
    id: 'reviews',
    icon: GitPullRequest,
    title: 'automations.template.reviews.title',
    summary: 'automations.template.reviews.summary',
    prompt: 'automations.template.reviews.prompt',
    schedule: { kind: 'daily', time: '14:00', weekdays: [1, 2, 3, 4, 5] },
  },
  {
    id: 'deps',
    icon: PackageCheck,
    title: 'automations.template.deps.title',
    summary: 'automations.template.deps.summary',
    prompt: 'automations.template.deps.prompt',
    schedule: { kind: 'daily', time: '10:00', weekdays: [1] },
  },
  {
    id: 'changelog',
    icon: ScrollText,
    title: 'automations.template.changelog.title',
    summary: 'automations.template.changelog.summary',
    prompt: 'automations.template.changelog.prompt',
    schedule: { kind: 'daily', time: '16:00', weekdays: [5] },
  },
  {
    id: 'news',
    icon: Newspaper,
    title: 'automations.template.news.title',
    summary: 'automations.template.news.summary',
    prompt: 'automations.template.news.prompt',
    schedule: { kind: 'daily', time: '08:00', weekdays: [1] },
  },
];

export function templateText(template: AutomationTemplate) {
  return { title: t(template.title), summary: t(template.summary), prompt: t(template.prompt) };
}
