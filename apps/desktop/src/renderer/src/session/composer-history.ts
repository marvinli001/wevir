import { browserLibraryDatabase } from '@/data/browser-library';
import { t } from '@/i18n';
import type { ComposerDraft } from './composer-drafts';
import { pastePreview } from './composer-pastes';

export interface HistorySummary {
  id: string;
  title: string;
  files: string;
}
interface SearchRecord extends HistorySummary {
  search: string;
}
export interface HistoryPage {
  items: HistorySummary[];
  more: boolean;
}

let sequence = 0;

export class ComposerHistory {
  private readonly temporary = new Map<string, { record: SearchRecord; draft: ComposerDraft }>();
  constructor(
    private readonly scope: string | undefined,
    private readonly active: () => boolean,
    private readonly unavailable: () => void,
  ) {}
  async append(draft: ComposerDraft, updateDraft: (table: IDBObjectStore) => void) {
    sequence = Math.max(sequence + 1, Date.now() * 1000);
    const id = `${sequence}-${crypto.randomUUID()}`;
    const text = draft.text || draft.pastes[0]?.text || '';
    const files = draft.attachments
      .map((file) => file.name ?? t('composer.attachImages'))
      .join(' · ');
    const record = {
      id,
      title: pastePreview(text || files),
      files: text ? files : '',
      search: [draft.text, ...draft.pastes.map((p) => p.text), files].join('\n').toLowerCase(),
    };
    if (this.scope !== undefined) {
      try {
        const db = await browserLibraryDatabase();
        if (!this.active()) return;
        const tx = db.transaction('composer', 'readwrite');
        const table = tx.objectStore('composer');
        table.put(record, [this.scope, 'history-index', id]);
        table.put(draft, [this.scope, 'history-body', id]);
        updateDraft(table);
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
        return;
      } catch {
        if (this.active()) this.unavailable();
      }
    }
    if (this.active()) this.temporary.set(id, { record, draft });
  }
  // 只扫描索引中的文字。游标遇到下一页即停止，只有选择一条历史时才读它的正文和 Blob。
  async search(query: string, before?: string, limit = 35): Promise<HistoryPage> {
    const needle = query.trim().toLowerCase();
    let rows: HistorySummary[] = [];
    const collect = (record: SearchRecord) => {
      if ((!needle || record.search.includes(needle)) && (!before || record.id < before))
        rows.push({ id: record.id, title: record.title, files: record.files });
    };
    if (this.scope !== undefined) {
      const db = await browserLibraryDatabase().catch((error) => {
        if (!this.temporary.size) throw error;
        return undefined;
      });
      if (db && this.active()) {
        const tx = db.transaction('composer');
        const range = IDBKeyRange.bound(
          [this.scope, 'history-index'],
          [this.scope, 'history-index', before ?? []],
          false,
          before !== undefined,
        );
        const request = tx.objectStore('composer').openCursor(range, 'prev');
        await new Promise<void>((resolve, reject) => {
          request.onsuccess = () => {
            const cursor = request.result;
            if (cursor && this.active()) {
              collect(cursor.value);
              if (rows.length <= limit) cursor.continue();
            }
          };
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
      }
    }
    if (!this.active()) return { items: [], more: false };
    if (this.temporary.size) {
      for (const { record } of this.temporary.values()) collect(record);
      rows = rows.sort((a, b) => b.id.localeCompare(a.id));
    }
    return { items: rows.slice(0, limit), more: rows.length > limit };
  }
  async read(id: string): Promise<ComposerDraft | undefined> {
    if (!this.active()) return;
    const temporary = this.temporary.get(id);
    if (temporary) return temporary.draft;
    if (this.scope === undefined) return;
    const db = await browserLibraryDatabase();
    if (!this.active()) return;
    const tx = db.transaction('composer');
    const request = tx.objectStore('composer').get([this.scope, 'history-body', id]);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(this.active() ? request.result : undefined);
      tx.onabort = () => reject(tx.error);
    });
  }
}
