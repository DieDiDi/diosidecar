// SPDX-License-Identifier: AGPL-3.0-or-later
// Sourced from plugin/src/zotero/store.ts in 54yyyu/zotero-mcp. See THIRD_PARTY_NOTICES.md.
// Chat history store ported directly from zotero-mcp/plugin/src/zotero/store.ts
// Uses Node fs/promises instead of Gecko IOUtils; preserves serialized writes and JSONL event replay.
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatEvent, SavedSession } from "../core/types.ts";

export function createSessionStore(dir: string) {
  const index = join(dir, "index.json");
  const file = (id: string) => join(dir, `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`);
  let chain: Promise<unknown> = Promise.resolve();

  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  async function readIndex(): Promise<SavedSession[]> {
    try {
      const raw = await readFile(index, "utf8");
      return (JSON.parse(raw) as { sessions?: SavedSession[] }).sessions ?? [];
    } catch {
      return [];
    }
  }

  return {
    sessions: () => serial(async () => (await readIndex()).sort((a, b) => b.updatedAt - a.updatedAt)),

    async loadEvents(id: string): Promise<ChatEvent[]> {
      try {
        const text = await readFile(file(id), "utf8");
        return text
          .split("\n")
          .filter(Boolean)
          .flatMap((l) => {
            try {
              return [JSON.parse(l) as ChatEvent];
            } catch {
              return [];
            }
          });
      } catch {
        return [];
      }
    },

    appendEvent: (session: SavedSession, ev: ChatEvent) =>
      serial(async () => {
        await mkdir(dir, { recursive: true });
        await appendFile(file(session.id), JSON.stringify(ev) + "\n", "utf8");
        const all = await readIndex();
        const i = all.findIndex((s) => s.id === session.id);
        const entry: SavedSession = { ...session, updatedAt: Date.now() };
        if (i >= 0) all[i] = entry;
        else all.push(entry);
        await writeFile(index, JSON.stringify({ sessions: all }, null, 2), "utf8");
      }),

    clearAll: () =>
      serial(async () => {
        await rm(dir, { recursive: true, force: true });
      }),

    deleteSession: (id: string) =>
      serial(async () => {
        await rm(file(id), { force: true });
        await mkdir(dir, { recursive: true });
        const next = (await readIndex()).filter((s) => s.id !== id);
        await writeFile(index, JSON.stringify({ sessions: next }, null, 2), "utf8");
      }),

    renameSession: (id: string, title: string) =>
      serial(async () => {
        const all = await readIndex();
        const i = all.findIndex((s) => s.id === id);
        const cur = i >= 0 ? all[i] : undefined;
        if (!cur) return;
        all[i] = { ...cur, title, titleLocked: true, updatedAt: Date.now() };
        await mkdir(dir, { recursive: true });
        await writeFile(index, JSON.stringify({ sessions: all }, null, 2), "utf8");
      }),
  };
}
