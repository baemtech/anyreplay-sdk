/// <reference types="vitest/globals" />

/** The part of jsdom app-origin-environment.ts uses; the package ships no types. */
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: Record<string, unknown>);
    readonly window: Window & typeof globalThis;
  }
}
