import {
  QUOTA_COOLDOWN_MS, SESSION_IDLE_MS, forgetVisitor, inCooldown, notePageCount, resolveIdentity, safeStorage,
  startCooldown, uuidv4,
} from '../src/visitor';

function memoryStorage(): globalThis.Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  } as globalThis.Storage;
}

describe('uuidv4', () => {
  it('matches the UUID format ingest requires', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(uuidv4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 500 }, () => uuidv4()));
    expect(seen.size).toBe(500);
  });
});

describe('safeStorage', () => {
  it('degrades to no-ops when storage throws', () => {
    // Private browsing modes throw on access; the recorder must not.
    const store = safeStorage(() => { throw new Error('blocked'); });
    expect(store.get('k')).toBeNull();
    expect(() => store.set('k', 'v')).not.toThrow();
    expect(() => store.remove('k')).not.toThrow();
  });

  it('degrades when storage is absent entirely', () => {
    const store = safeStorage(() => undefined);
    expect(store.get('k')).toBeNull();
    expect(() => store.set('k', 'v')).not.toThrow();
  });
});

describe('resolveIdentity', () => {
  it('creates and then reuses a visitor id', () => {
    const l = memoryStorage(); const s = memoryStorage();
    const wrapL = safeStorage(() => l); const wrapS = safeStorage(() => s);

    const first = resolveIdentity(wrapL, wrapS, 1000);
    const second = resolveIdentity(wrapL, wrapS, 2000);
    expect(second.visitorId).toBe(first.visitorId);
  });

  it('keeps the session while the visitor stays active', () => {
    const l = memoryStorage(); const s = memoryStorage();
    const wrapL = safeStorage(() => l); const wrapS = safeStorage(() => s);

    const first = resolveIdentity(wrapL, wrapS, 1000);
    const later = resolveIdentity(wrapL, wrapS, 1000 + SESSION_IDLE_MS - 1);
    expect(later.sessionId).toBe(first.sessionId);
    expect(later.isNewSession).toBe(false);
  });

  it('starts a new session after the idle window', () => {
    const l = memoryStorage(); const s = memoryStorage();
    const wrapL = safeStorage(() => l); const wrapS = safeStorage(() => s);

    const first = resolveIdentity(wrapL, wrapS, 1000);
    const after = resolveIdentity(wrapL, wrapS, 1000 + SESSION_IDLE_MS + 1);
    expect(after.sessionId).not.toBe(first.sessionId);
    expect(after.isNewSession).toBe(true);
    // The visitor is the same person across sessions.
    expect(after.visitorId).toBe(first.visitorId);
  });

  it('replaces a corrupted visitor id rather than sending it upstream', () => {
    const l = memoryStorage(); const s = memoryStorage();
    l.setItem('anyreplay.vid', '../../etc/passwd');
    const wrapL = safeStorage(() => l); const wrapS = safeStorage(() => s);

    const identity = resolveIdentity(wrapL, wrapS, 1000);
    expect(identity.visitorId).toMatch(/^v[0-9a-f]{24}$/);
  });

  it('still works when storage is unavailable, without persisting', () => {
    const blocked = safeStorage(() => { throw new Error('nope'); });
    const identity = resolveIdentity(blocked, blocked, 1000);
    expect(identity.visitorId).toMatch(/^v[0-9a-f]{24}$/);
    expect(identity.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('chunk numbering across page loads', () => {
  const memory = () => {
    const values = new Map<string, string>();
    return {
      get: (key: string) => values.get(key) ?? null,
      set: (key: string, value: string) => { values.set(key, value); },
      remove: (key: string) => { values.delete(key); },
    };
  };

  it('starts a new session at chunk 0', async () => {
    const { resolveIdentity: resolve } = await import('../src/visitor');
    expect(resolve(memory(), memory(), 1_000).nextSeq).toBe(0);
  });

  it('resumes a session at the number the previous page reserved', async () => {
    const { resolveIdentity: resolve, reserveSeq } = await import('../src/visitor');
    const local = memory();
    const session = memory();
    const first = resolve(local, session, 1_000);
    reserveSeq(session, 5);

    const second = resolve(local, session, 2_000);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.nextSeq).toBe(5);
  });

  it('starts over when the session has expired', async () => {
    const { resolveIdentity: resolve, reserveSeq, SESSION_IDLE_MS: idle } = await import('../src/visitor');
    const local = memory();
    const session = memory();
    const first = resolve(local, session, 1_000);
    reserveSeq(session, 5);

    const later = resolve(local, session, 1_000 + idle + 1);
    expect(later.sessionId).not.toBe(first.sessionId);
    expect(later.nextSeq).toBe(0);
  });
});

describe('page count across page loads', () => {
  const memory = () => {
    const values = new Map<string, string>();
    return {
      get: (key: string) => values.get(key) ?? null,
      set: (key: string, value: string) => { values.set(key, value); },
      remove: (key: string) => { values.delete(key); },
    };
  };

  it('is 1 for a new session', () => {
    expect(resolveIdentity(memory(), memory(), 1_000).pageCount).toBe(1);
  });

  it('continues from where the previous page left off, including in-app navigations', () => {
    const local = memory();
    const session = memory();
    resolveIdentity(local, session, 1_000);
    notePageCount(session, 3);
    expect(resolveIdentity(local, session, 2_000).pageCount).toBe(4);
  });

  it('restarts with the session', () => {
    const local = memory();
    const session = memory();
    resolveIdentity(local, session, 1_000);
    notePageCount(session, 3);
    expect(resolveIdentity(local, session, 1_000 + SESSION_IDLE_MS + 1).pageCount).toBe(1);
  });
});

describe('forgetVisitor', () => {
  it('removes every key the recorder ever writes, in both storages', () => {
    const l = memoryStorage(); const s = memoryStorage();
    const local = safeStorage(() => l); const session = safeStorage(() => s);
    resolveIdentity(local, session, 1_000);
    notePageCount(session, 3);
    startCooldown(session, 1_000);
    expect(l.length).toBe(1);
    expect(s.length).toBe(5);

    forgetVisitor(local, session);
    expect(l.length).toBe(0);
    expect(s.length).toBe(0);
    // Gone for good: the next resolution is a new visitor in a new session.
    const after = resolveIdentity(local, session, 2_000);
    expect(after.isNewSession).toBe(true);
    expect(after.nextSeq).toBe(0);
  });

  it('creates nothing when there was nothing to forget', () => {
    const l = memoryStorage(); const s = memoryStorage();
    forgetVisitor(safeStorage(() => l), safeStorage(() => s));
    expect(l.length + s.length).toBe(0);
  });

  it('is harmless when storage is unavailable', () => {
    const blocked = safeStorage(() => { throw new Error('nope'); });
    expect(() => forgetVisitor(blocked, blocked)).not.toThrow();
  });
});

describe('cool-down after a refused session', () => {
  it('lasts for the documented window and no longer', () => {
    const backing = memoryStorage();
    const session = safeStorage(() => backing);
    expect(inCooldown(session, 1_000)).toBe(false);
    startCooldown(session, 1_000);
    expect(inCooldown(session, 1_000 + QUOTA_COOLDOWN_MS - 1)).toBe(true);
    expect(inCooldown(session, 1_000 + QUOTA_COOLDOWN_MS)).toBe(false);
  });

  it('is off when storage is unavailable, so a private window still records', () => {
    const blocked = safeStorage(() => { throw new Error('nope'); });
    startCooldown(blocked, 1_000);
    expect(inCooldown(blocked, 1_001)).toBe(false);
  });
});
