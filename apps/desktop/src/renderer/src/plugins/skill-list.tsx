// “Skills”分段（0.42.0，desktop-layout.md §23）：Wevir、我的（~/.agents/skills）、项目三组，开关、SKILL.md 预览、在访达中显示与删除。

import type { Skill } from '@wevir/protocol';
import { cn } from 'cn';
import { FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { IS_MAC } from '@/lib/shortcuts';
import { MarkdownView } from '@/session/markdown/markdown-view';
import { EmptyList, LIST_CARD } from '@/settings/settings-ui';
import { removeSkill, setSkillEnabled } from './plugin-actions';
import { DetailActions, DetailSection, ExpandableRow, MonoBlock } from './plugin-rows';
import { usePluginsContext } from './plugins-context';
import {
  groupSkills,
  originName,
  type SkillGroups,
  skillBody,
  skillProject,
  skillSummary,
} from './plugins-model';

const GROUPS = [
  { key: 'wevir', title: 'plugins.skill.group.wevir' },
  { key: 'user', title: 'plugins.skill.group.user' },
  { key: 'project', title: 'plugins.skill.group.project' },
] as const satisfies readonly { key: keyof SkillGroups; title: string }[];

export function SkillList({
  expanded,
  onExpand,
}: {
  expanded: string | undefined;
  onExpand: (id: string | undefined) => void;
}) {
  const { list } = usePluginsContext();
  const groups = groupSkills(list.skills);
  if (list.skills.length === 0) return <EmptyList>{t('plugins.empty.skills')}</EmptyList>;
  return (
    <div className="space-y-6" data-testid="skill-list">
      {GROUPS.filter((group) => groups[group.key].length > 0).map((group) => (
        <section key={group.key} data-skill-group={group.key}>
          <h3 className="mb-2 px-1 text-xs font-medium text-muted-foreground">{t(group.title)}</h3>
          <ul className={cn(LIST_CARD, 'overflow-hidden')}>
            {groups[group.key].map((skill) => (
              <SkillRow
                key={skill.id}
                skill={skill}
                expanded={expanded === skill.id}
                onToggle={() => onExpand(expanded === skill.id ? undefined : skill.id)}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function SkillRow({
  skill,
  expanded,
  onToggle,
}: {
  skill: Skill;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { client, data, plugins, busy, run } = usePluginsContext();
  const plugin = skill.pluginId === undefined ? undefined : plugins.get(skill.pluginId);
  const origin = originName(skill.pluginId, plugins);
  // 名称后面的小字：来自哪个插件；项目 Skills 写项目文件夹名。
  const note =
    origin !== undefined
      ? t('plugins.from', { name: origin })
      : skill.source === 'project'
        ? skillProject(skill)
        : undefined;
  return (
    <ExpandableRow
      id={skill.id}
      expanded={expanded}
      onToggle={onToggle}
      title={
        <>
          {skill.name}
          {note && <span className="ml-2 text-xs font-normal text-muted-foreground">{note}</span>}
        </>
      }
      meta={skillSummary(skill)}
      control={
        <Switch
          checked={skill.enabled}
          label={t('plugins.skill.enabled', { name: skill.name })}
          disabled={plugin?.enabled === false || busy.has(skill.id)}
          onChange={(next) =>
            run(
              skill.id,
              () => setSkillEnabled(client, data, skill.id, next),
              (error) => t('plugins.toggleFailed', { error }),
            )
          }
          data-action="toggle-skill"
        />
      }
    >
      <SkillDetail skill={skill} />
    </ExpandableRow>
  );
}

function SkillDetail({ skill }: { skill: Skill }) {
  const { client, data, plugins, notify, openPlugin } = usePluginsContext();
  const [confirming, setConfirming] = useState(false);
  const owner = skill.pluginId === undefined ? undefined : plugins.get(skill.pluginId);
  // 只有 Wevir 自己装的（不属于插件的）能删；别的由插件卸载或用户的文件管理。
  const removable = skill.source === 'wevir' && skill.pluginId === undefined;
  return (
    <>
      <p className="text-sm break-words text-soft-foreground">{skill.description}</p>
      <DetailSection title="SKILL.md">
        <SkillPreview path={skill.path} />
      </DetailSection>
      <DetailSection title={t('plugins.skill.path')}>
        <MonoBlock>{skill.path}</MonoBlock>
      </DetailSection>
      <DetailActions>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void window.wevir.revealPath(skill.path).catch(() => undefined)}
          data-action="reveal-skill"
        >
          <FolderOpen data-icon="inline-start" />
          {t(IS_MAC ? 'files.revealFinder' : 'files.revealFolder')}
        </Button>
        {removable && (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setConfirming(true)}
            data-action="delete-skill"
          >
            {t('plugins.skill.delete')}
          </Button>
        )}
        {owner && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => openPlugin(owner.id)}
            data-action="open-plugin"
          >
            {t('plugins.openPlugin')}
          </Button>
        )}
      </DetailActions>
      {removable && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={t('plugins.skill.delete.title', { name: skill.name })}
          confirmLabel={t('plugins.skill.delete')}
          failure={(error) => t('plugins.skill.delete.failed', { error })}
          onConfirm={async () => {
            await removeSkill(client, data, skill);
            notify({ tone: 'success', text: t('plugins.skill.deleted', { name: skill.name }) });
          }}
        >
          <p>{t('plugins.skill.delete.body')}</p>
        </ConfirmDialog>
      )}
    </>
  );
}

/** SKILL.md 的预览（展开时才读）：去掉 frontmatter，用消息流的 Markdown 渲染，最高 320 px 内部滚动。 */
function SkillPreview({ path }: { path: string }) {
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'ready'; body: string } | { status: 'error'; error: string }
  >({ status: 'loading' });
  useEffect(() => {
    let stopped = false;
    setState({ status: 'loading' });
    window.wevir
      .readSkillFile(path)
      .then((text) => !stopped && setState({ status: 'ready', body: skillBody(text) }))
      .catch(
        (reason: unknown) => !stopped && setState({ status: 'error', error: describe(reason) }),
      );
    return () => {
      stopped = true;
    };
  }, [path]);

  if (state.status === 'loading') {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  }
  if (state.status === 'error') {
    return (
      <p role="alert" className="text-sm break-words text-destructive">
        {t('plugins.skill.previewFailed', { error: state.error })}
      </p>
    );
  }
  return (
    <div
      className="max-h-80 overflow-auto rounded-lg border border-border bg-background px-3 py-2 text-sm"
      data-testid="skill-preview"
    >
      <MarkdownView text={state.body} streaming={false} />
    </div>
  );
}
