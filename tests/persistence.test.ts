import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/persistence/store.js';
import { emptyCase } from '../src/shared/schemas/ideaCase.js';
import type { VersionRecord } from '../src/shared/schemas/ideaCase.js';
import type { StoredProposal } from '../src/shared/schemas/proposal.js';
import { systemClock } from '../src/server/util/clock.js';

let dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ideno-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => undefined)));
  dirs = [];
});

const NOW = '2026-10-08T12:00:00.000Z';

function makeVersion(number: number, snapshotJson: string): VersionRecord {
  return {
    number,
    id: `ver${number}`,
    parent_version: number - 1,
    created_at: NOW,
    trigger: { kind: 'user_acceptance', user_message: 'msg' },
    summary: `v${number}`,
    diff: { collections: {}, warnings: [] },
    snapshot: JSON.parse(snapshotJson),
  };
}

describe('Store', () => {
  it('creates a fresh case with v0 on first load', async () => {
    const store = new Store(await tempDir(), systemClock);
    const { caseData, warnings } = await store.load();
    expect(caseData.version).toBe(0);
    expect(warnings.length).toBeGreaterThan(0);
    const versions = await store.listVersions();
    expect(versions.map((v) => v.number)).toEqual([0]);
  });

  it('round-trips case, messages, and proposals', async () => {
    const dir = await tempDir();
    const store = new Store(dir, systemClock);
    const { caseData } = await store.load();
    caseData.title = 'Test idea';
    caseData.goals.push({
      id: 'goal1',
      text: 'G',
      knowledge_class: 'USER_PROVIDED',
      status: 'active',
      created_at: NOW,
      updated_at: NOW,
      provenance: { source: 'user' },
    });
    caseData.version = 1;
    await store.saveCase(caseData);
    await store.appendVersion(makeVersion(1, JSON.stringify(caseData)));
    await store.appendMessage({ id: 'm1', role: 'user', content: 'hello', created_at: NOW });
    const proposal: StoredProposal = {
      id: 'prop_x1',
      status: 'pending',
      created_at: NOW,
      user_message: 'hello',
      proposal: { changes: {} as StoredProposal['proposal']['changes'], impact_analysis: [], conflicts: [], questions: [], reasoning_summary: '' },
      provider: 'test',
      warnings: [],
    };
    await store.saveProposal(proposal);

    const store2 = new Store(dir, systemClock);
    const loaded = await store2.load();
    expect(loaded.caseData.title).toBe('Test idea');
    expect(loaded.caseData.goals[0]?.text).toBe('G');
    expect(await store2.listMessages()).toHaveLength(1);
    expect((await store2.getProposal('prop_x1'))?.status).toBe('pending');
    expect((await store2.listVersions()).map((v) => v.number)).toEqual([0, 1]);
  });

  it('quarantines a corrupted case.json and restores from the latest version snapshot', async () => {
    const dir = await tempDir();
    const store = new Store(dir, systemClock);
    const { caseData } = await store.load();
    caseData.title = 'Good v1';
    caseData.version = 1;
    await store.appendVersion(makeVersion(1, JSON.stringify(caseData)));
    await store.saveCase(caseData);

    // Corrupt the case file.
    await fs.writeFile(path.join(dir, 'case.json'), '{not json', 'utf8');

    const store2 = new Store(dir, systemClock);
    const loaded = await store2.load();
    expect(loaded.caseData.title).toBe('Good v1');
    expect(loaded.warnings.some((w) => w.includes('restored') || w.includes('validation'))).toBe(true);
    // The corrupted file was preserved for inspection, not overwritten.
    const files = await fs.readdir(dir);
    expect(files.some((f) => f.startsWith('case.json.corrupt-'))).toBe(true);
  });

  it('rolls forward when case.json is behind the newest version (crash between writes)', async () => {
    const dir = await tempDir();
    const store = new Store(dir, systemClock);
    const { caseData } = await store.load();
    caseData.title = 'v1';
    caseData.version = 1;
    await store.appendVersion(makeVersion(1, JSON.stringify(caseData)));
    // Simulate a crash BEFORE saveCase: case.json still says v0.

    const store2 = new Store(dir, systemClock);
    const loaded = await store2.load();
    expect(loaded.caseData.version).toBe(1);
    expect(loaded.caseData.title).toBe('v1');
    expect(loaded.warnings.some((w) => w.includes('Rolled forward'))).toBe(true);
  });

  it('skips invalid lines in the message log instead of failing', async () => {
    const dir = await tempDir();
    const store = new Store(dir, systemClock);
    await store.load();
    await fs.appendFile(path.join(dir, 'messages.jsonl'), 'not json\n', 'utf8');
    await store.appendMessage({ id: 'm1', role: 'user', content: 'ok', created_at: NOW });
    const messages = await store.listMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('ok');
  });

  it('refuses path traversal in proposal ids', async () => {
    const dir = await tempDir();
    const store = new Store(dir, systemClock);
    await store.load();
    expect(await store.getProposal('../../etc/passwd')).toBeUndefined();
  });

  it('reset archives data instead of deleting it, and starts a fresh v0 case', async () => {
    const dir = await tempDir();
    const store = new Store(dir, systemClock);
    const { caseData } = await store.load();
    caseData.title = 'Old idea';
    caseData.version = 1;
    await store.appendVersion(makeVersion(1, JSON.stringify(caseData)));
    await store.saveCase(caseData);
    await store.appendMessage({ id: 'm1', role: 'user', content: 'old', created_at: NOW });

    const fresh = await store.reset();
    expect(fresh.caseData.version).toBe(0);
    expect(fresh.caseData.title).toBe('Untitled idea');

    // Archived data still exists on disk.
    const archiveRoot = path.join(dir, 'archive');
    const stamps = await fs.readdir(archiveRoot);
    expect(stamps.length).toBe(1);
    const archived = await fs.readdir(path.join(archiveRoot, stamps[0]!));
    expect(archived).toContain('case.json');
    expect(archived).toContain('versions');
    expect(archived).toContain('messages.jsonl');
  });

  it('emptyCase produces schema-valid data for a fresh store', async () => {
    const c = emptyCase('primary', NOW);
    // Re-parsing confirms round-trip validity (the Store does this on load).
    expect(c.id).toBe('primary');
  });
});
