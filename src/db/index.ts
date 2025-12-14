import Dexie, { Table } from "dexie";
import type {
  QueueItem,
  ResultRecord,
  PromptDoc,
  SettingsDoc
} from "../shared/types";

export class LabelerDB extends Dexie {
  queue!: Table<QueueItem, string>;
  results!: Table<ResultRecord, string>;
  settings!: Table<SettingsDoc, string>;
  prompts!: Table<PromptDoc, string>;
  // Legacy table kept for migration; will be ignored otherwise.
  scripts!: Table<any, string>;

  constructor() {
    super("llm-labeler");
    this.version(1).stores({
      queue: "id,status,target,createdAt,updatedAt",
      results: "id,sampleId,target,createdAt",
      scripts: "id",
      settings: "id"
    });
    this.version(2)
      .stores({
        queue: "id,status,target,createdAt,updatedAt",
        results: "id,sampleId,target,createdAt",
        scripts: "id",
        settings: "id",
        prompts: "id"
      })
      .upgrade(async (tx) => {
        try {
          const legacy = await tx.table("scripts").toArray();
          const prompts = tx.table("prompts");
          await Promise.all(
            legacy.map((doc: any) =>
              prompts.put({
                id: doc.id,
                prompt: doc.prompt ?? doc.code ?? "",
                updatedAt: doc.updatedAt ?? Date.now()
              } satisfies PromptDoc)
            )
          );
        } catch {
          // Best-effort migration; ignore if legacy table is absent.
        }
      });

    this.version(3)
      .stores({
        queue: "id,status,target,createdAt,updatedAt,seq,[status+seq]",
        results: "id,sampleId,target,createdAt",
        scripts: "id",
        settings: "id",
        prompts: "id"
      })
      .upgrade(async (tx) => {
        const queue = tx.table("queue");
        let seq = 0;
        await queue.orderBy("createdAt").modify((item: any) => {
          item.seq = seq++;
        });
      });
  }
}

export const db = new LabelerDB();

export const DEFAULT_SETTINGS: SettingsDoc = {
  id: "active",
  responseDelayMs: 2000,
  batchSize: 20,
  samplePercent: 100,
  outputCountMode: "match_input",
  updatedAt: Date.now()
};
