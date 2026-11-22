/**
 * A stand-in for the parts of `@tauri-apps/api` the SDK uses, with switches
 * for the ways a real app can differ: not running inside Tauri, an older
 * Tauri without `getIdentifier`, a capability that refuses an event.
 */
export const tauri = {
  inside: true,
  identifier: 'com.acme.notes' as string | Error,
  name: 'Acme Notes' as string | Error,
  version: '2.3.1' as string | Error,
  listenFails: false,
  focusListeners: [] as ((event: { payload: boolean }) => void)[],
  closeListeners: [] as ((event: unknown) => Promise<void> | void)[],
  reset(): void {
    this.inside = true;
    this.identifier = 'com.acme.notes';
    this.name = 'Acme Notes';
    this.version = '2.3.1';
    this.listenFails = false;
    this.focusListeners = [];
    this.closeListeners = [];
  },
};

const answer = async (value: string | Error): Promise<string> => {
  if (value instanceof Error) throw value;
  return value;
};

export const appModule = {
  getIdentifier: () => answer(tauri.identifier),
  getName: () => answer(tauri.name),
  getVersion: () => answer(tauri.version),
};

export const coreModule = {
  isTauri: () => tauri.inside,
};

export const windowModule = {
  getCurrentWindow: () => ({
    onFocusChanged: async (listener: (event: { payload: boolean }) => void) => {
      if (tauri.listenFails) throw new Error('event.listen not allowed. Permissions associated with this command: core:event:allow-listen');
      tauri.focusListeners.push(listener);
      return () => {};
    },
    onCloseRequested: async (listener: (event: unknown) => Promise<void> | void) => {
      tauri.closeListeners.push(listener);
      return () => {};
    },
  }),
};
