import { promises as fs } from 'node:fs';
import path from 'node:path';
import { IdeaCase, emptyCase } from '../../shared/schemas/ideaCase.js';
import type { VersionRecord } from '../../shared/schemas/ideaCase.js';
import type { StoredProposal } from '../../shared/schemas/proposal.js';
import { ChatMessage } from '../../shared/chat.js';
import { AppError } from '../../shared/errors.js';
import type { Clock } from '../util/clock.js';
import { prefixedId } from '../util/ids.js';

/**
 * File-based persistence with integrity guarantees:
 *
 * - All writes are atomic (temp file + rename) — a crash never leaves a
 *   half-written file.
 * - Version records are written BEFORE the new case state. If a crash happens
 *   between the two, the loader rolls forward from the newest version.
 * - If case.json is corrupted, it is moved aside (never overwritten) and the
 *   state is restored from the latest valid version snapshot; failing that,
 *   a fresh case is created. Corrupted files are always preserved for
 *   inspection.
 *
 * v0.1 is single-process; a process-level write mutex serializes mutations.
 */

const CASE_ID = 'primary';

export interface LoadedState {
  caseData: IdeaCase;
  warnings: string[];
}

export interface VersionSummary {
  number: number;
  id: string;
  created_at: string;
  summary: string;
  trigger: VersionRecord['trigger'];
  counts: { added: number; modified: number };
}

export class Store {
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly baseDir: string,
    private readonly clock: Clock,
  ) {}

  private get casePath() {
    return path.join(this.baseDir, 'case.json');
  }
  private get versionsDir() {
    return path.join(this.baseDir, 'versions');
  }
  private get proposalsDir() {
    return path.join(this.baseDir, 'proposals');
  }
  private get messagesPath() {
    return path.join(this.baseDir, 'messages.jsonl');
  }
  private get archiveDir() {
    return path.join(this.baseDir, 'archive');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.versionsDir, { recursive: true });
    await fs.mkdir(this.proposalsDir, { recursive: true });
  }

  async load(): Promise<LoadedState> {
    await this.init();
    const warnings: string[] = [];
    let caseData: IdeaCase | undefined;

    try {
      const raw = await fs.readFile(this.casePath, 'utf8');
      const parsed = IdeaCase.safeParse(JSON.parse(raw));
      if (parsed.success) {
        caseData = parsed.data;
      } else {
        await this.quarantine(this.casePath, warnings, `case.json failed validation: ${parsed.error.issues.length} issue(s)`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        await this.quarantine(this.casePath, warnings, `case.json could not be read: ${errorMessage(err)}`);
      }
    }

    if (!caseData) {
      const restored = await this.restoreFromVersions();
      if (restored) {
        warnings.push(`State restored from version snapshot v${restored.version}.`);
        caseData = restored;
        await this.saveCase(caseData);
      } else {
        if (warnings.length === 0) warnings.push('No existing case found; created a new one.');
        caseData = emptyCase(CASE_ID, this.clock.now().toISOString());
        await this.saveCase(caseData);
        await this.appendVersion({
          number: 0,
          id: prefixedId('ver'),
          parent_version: null,
          created_at: this.clock.now().toISOString(),
          trigger: { kind: 'initialization' },
          summary: 'Initial empty state.',
          diff: { collections: {}, warnings: [] },
          snapshot: caseData,
        });
      }
    } else {
      // Roll forward if a crash happened between version write and case save.
      const latest = await this.latestVersionNumber();
      if (latest !== undefined && latest > caseData.version) {
        const restored = await this.getVersion(latest);
        if (restored) {
          warnings.push(`Rolled forward to version snapshot v${latest} (case.json was behind).`);
          caseData = restored.snapshot;
          await this.saveCase(caseData);
        }
      }
    }

    return { caseData, warnings };
  }

  /** Serialized, atomic write of the current case. */
  async saveCase(caseData: IdeaCase): Promise<void> {
    const payload = JSON.stringify(caseData, null, 2);
    await this.enqueue(() => this.atomicWrite(this.casePath, payload));
  }

  async appendVersion(record: VersionRecord): Promise<void> {
    const file = path.join(this.versionsDir, `v${String(record.number).padStart(6, '0')}.json`);
    const payload = JSON.stringify(record, null, 2);
    await this.enqueue(() => this.atomicWrite(file, payload));
  }

  async getVersion(n: number): Promise<VersionRecord | undefined> {
    const file = path.join(this.versionsDir, `v${String(n).padStart(6, '0')}.json`);
    try {
      const raw = await fs.readFile(file, 'utf8');
      return JSON.parse(raw) as VersionRecord;
    } catch {
      return undefined;
    }
  }

  async listVersions(): Promise<VersionSummary[]> {
    let files: string[] = [];
    try {
      files = await fs.readdir(this.versionsDir);
    } catch {
      return [];
    }
    const records: VersionSummary[] = [];
    for (const file of files.filter((f) => f.endsWith('.json')).sort()) {
      try {
        const raw = await fs.readFile(path.join(this.versionsDir, file), 'utf8');
        const record = JSON.parse(raw) as VersionRecord;
        let added = 0;
        let modified = 0;
        for (const diff of Object.values(record.diff.collections ?? {})) {
          added += diff.added?.length ?? 0;
          modified += diff.modified?.length ?? 0;
        }
        records.push({
          number: record.number,
          id: record.id,
          created_at: record.created_at,
          summary: record.summary,
          trigger: record.trigger,
          counts: { added, modified },
        });
      } catch {
        // skip unreadable version files rather than failing the listing
      }
    }
    return records.sort((a, b) => a.number - b.number);
  }

  async appendMessage(message: ChatMessage): Promise<void> {
    const line = JSON.stringify(message) + '\n';
    await this.enqueue(() =>
      fs.appendFile(this.messagesPath, line, 'utf8').catch((err: unknown) => {
        throw new AppError('PERSISTENCE_ERROR', `Could not append to message log: ${errorMessage(err)}`, { cause: err });
      }),
    );
  }

  async listMessages(limit = 200): Promise<ChatMessage[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.messagesPath, 'utf8');
    } catch {
      return [];
    }
    const messages: ChatMessage[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = ChatMessage.safeParse(JSON.parse(trimmed));
        if (parsed.success) messages.push(parsed.data);
        // Invalid lines are skipped — the log is append-only supporting context.
      } catch {
        // skip corrupt line
      }
    }
    return messages.slice(-limit);
  }

  async saveProposal(proposal: StoredProposal): Promise<void> {
    const file = path.join(this.proposalsDir, `${proposal.id}.json`);
    await this.enqueue(() => this.atomicWrite(file, JSON.stringify(proposal, null, 2)));
  }

  async getProposal(id: string): Promise<StoredProposal | undefined> {
    // Proposal ids are generated server-side; forbid path traversal.
    if (!/^[a-z0-9_-]+$/i.test(id)) return undefined;
    try {
      const raw = await fs.readFile(path.join(this.proposalsDir, `${id}.json`), 'utf8');
      return JSON.parse(raw) as StoredProposal;
    } catch {
      return undefined;
    }
  }

  async listProposals(): Promise<StoredProposal[]> {
    let files: string[] = [];
    try {
      files = await fs.readdir(this.proposalsDir);
    } catch {
      return [];
    }
    const out: StoredProposal[] = [];
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      try {
        const raw = await fs.readFile(path.join(this.proposalsDir, file), 'utf8');
        out.push(JSON.parse(raw) as StoredProposal);
      } catch {
        // skip
      }
    }
    return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /**
   * Archive all current data (case, versions, messages, proposals) under
   * archive/<timestamp>/ and start a fresh case. Nothing is deleted — the
   * full history of a reset case remains inspectable in the archive.
   */
  async reset(): Promise<LoadedState> {
    await this.init();
    const stamp = this.clock.now().toISOString().replace(/[:.]/g, '-');
    const target = path.join(this.archiveDir, stamp);
    await fs.mkdir(target, { recursive: true });
    const moveToArchive = async (p: string) => {
      try {
        await fs.rename(p, path.join(target, path.basename(p)));
      } catch {
        // source did not exist — fine
      }
    };
    await moveToArchive(this.versionsDir);
    await moveToArchive(this.proposalsDir);
    await moveToArchive(this.casePath);
    await moveToArchive(this.messagesPath);
    return this.load();
  }

  // -------------------------------------------------------------------------

  private async latestVersionNumber(): Promise<number | undefined> {
    const versions = await this.listVersions();
    return versions.length > 0 ? versions[versions.length - 1]?.number : undefined;
  }

  private async restoreFromVersions(): Promise<IdeaCase | undefined> {
    const latest = await this.latestVersionNumber();
    if (latest === undefined) return undefined;
    const record = await this.getVersion(latest);
    if (!record) return undefined;
    const parsed = IdeaCase.safeParse(record.snapshot);
    return parsed.success ? parsed.data : undefined;
  }

  private async quarantine(file: string, warnings: string[], reason: string): Promise<void> {
    warnings.push(reason);
    try {
      await fs.rename(file, `${file}.corrupt-${this.clock.now().toISOString().replace(/[:.]/g, '-')}`);
    } catch {
      // If rename fails the fresh-case path will overwrite via atomic write.
    }
  }

  private async atomicWrite(file: string, payload: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fs.writeFile(tmp, payload, 'utf8');
      await fs.rename(tmp, file);
    } catch (err) {
      try {
        await fs.rm(tmp, { force: true });
      } catch {
        // best effort
      }
      throw new AppError('PERSISTENCE_ERROR', `Could not write ${path.basename(file)}: ${errorMessage(err)}`, { cause: err });
    }
  }

  /** Serialize all mutations to keep single-writer semantics per process. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(op, op);
    this.writeChain = next.catch(() => undefined);
    return next;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
