/**
 * The globals a `page.evaluate` callback sees, for probes that are TypeScript.
 *
 * A probe's browser-side callbacks are serialized and run in the renderer, so
 * `window` and `document` have to resolve at compile time even though nothing
 * here ever executes in this process. Importing this module for its side effect
 * is what makes them resolve:
 *
 *     import "../lib/renderer-globals.js";
 *
 * `window.deskrag` is typed as the app's OWN `DeskRagApi`, which is the point:
 * a probe reading a DTO field that no longer exists now fails `npm run
 * typecheck` instead of reading `undefined` at runtime and reporting it as a
 * finding about the app.
 *
 * The DOM half is DELIBERATELY MINIMAL and not `lib: ["dom"]`. Adding the DOM
 * lib is a tsconfig-wide switch, and it would let renderer globals typecheck
 * inside `src/` — a library that must never touch them. What is declared here
 * is what the probes actually call, and nothing else; extend it when a probe
 * needs more, rather than reaching for the lib.
 */

import type { DeskRagApi } from "@shared/types";

declare global {
  interface Window {
    deskrag: DeskRagApi;
    innerWidth: number;
    innerHeight: number;
    devicePixelRatio: number;
    scrollTo(x: number, y: number): void;
  }

  /** Only the members the probes call. See the header before widening. */
  interface ProbeElement {
    textContent: string | null;
    className: string;
    classList: { contains(token: string): boolean };
    getAttribute(name: string): string | null;
    getBoundingClientRect(): {
      x: number;
      y: number;
      width: number;
      height: number;
      top: number;
      right: number;
      bottom: number;
      left: number;
    };
    querySelector(selectors: string): ProbeElement | null;
    querySelectorAll(selectors: string): ArrayLike<ProbeElement> & Iterable<ProbeElement>;
    click(): void;
    scrollIntoView(arg?: unknown): void;
    /** Layout, for the overflow checks — a label either fits or is withheld. */
    scrollWidth: number;
    clientWidth: number;
    scrollHeight: number;
    clientHeight: number;
  }

  const window: Window;
  const document: ProbeElement & {
    documentElement: ProbeElement;
    body: ProbeElement;
  };
  function getComputedStyle(el: ProbeElement): Record<string, string> & {
    getPropertyValue(property: string): string;
  };
  /**
   * AUGMENTED, not declared: `@types/node` already has a `Navigator` and a
   * `navigator`, so a second declaration collides. `probe:habits` round-trips
   * a HABIT.md through the clipboard, byte for byte.
   */
  interface Navigator {
    clipboard: { writeText(text: string): Promise<void>; readText(): Promise<string> };
  }
}

export {};
