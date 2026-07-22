/**
 * Structured event digest (view 3): a templated, deterministic text summary of a
 * segment's input signals — "app focus: Slack → VS Code. 42 clicks, heavy
 * scrolling, 5 keystrokes. typed in Slack, clicked in VS Code." This text is
 * what gets embedded; the exact prose matters less than that it is STABLE and
 * carries the signal, since the embedding handles fuzzy matching.
 *
 * Typing/clicking are attributed to whichever app was focused at the time, by
 * walking events in order and tracking the current app from focus_change events.
 */

export interface DigestEvent {
  tMono: number;
  kind: string;
  data?: unknown;
}

interface AppTally {
  clicks: number;
  keys: number;
  scrolls: number;
}

function appOf(data: unknown): string | undefined {
  if (data && typeof data === "object" && "app" in data) {
    const app = (data as { app?: unknown }).app;
    if (typeof app === "string" && app.length > 0) return app;
  }
  return undefined;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

export function buildDigest(events: readonly DigestEvent[]): string {
  const ordered = [...events].sort((a, b) => a.tMono - b.tMono);

  let clicks = 0;
  let keys = 0;
  let scrolls = 0;
  let moves = 0;
  const appSeq: string[] = [];
  const perApp = new Map<string, AppTally>();
  let currentApp: string | undefined;

  const tally = (fn: (t: AppTally) => void) => {
    if (currentApp === undefined) return;
    const t = perApp.get(currentApp) ?? { clicks: 0, keys: 0, scrolls: 0 };
    fn(t);
    perApp.set(currentApp, t);
  };

  for (const ev of ordered) {
    switch (ev.kind) {
      case "focus_change": {
        const app = appOf(ev.data);
        if (app !== undefined) {
          currentApp = app;
          if (appSeq[appSeq.length - 1] !== app) appSeq.push(app);
        }
        break;
      }
      case "mouse_down":
        clicks++;
        tally((t) => t.clicks++);
        break;
      case "key_down":
        keys++;
        tally((t) => t.keys++);
        break;
      case "scroll":
        scrolls++;
        tally((t) => t.scrolls++);
        break;
      case "mouse_move":
        moves++;
        break;
    }
  }

  if (clicks + keys + scrolls + moves === 0 && appSeq.length === 0) {
    return "idle segment";
  }

  const parts: string[] = [];
  if (appSeq.length > 0) parts.push(`app focus: ${appSeq.join(" → ")}`);

  const activity: string[] = [];
  if (clicks > 0) activity.push(plural(clicks, "click"));
  if (scrolls > 0) activity.push(scrolls <= 5 ? "light scrolling" : "heavy scrolling");
  if (keys > 0) activity.push(plural(keys, "keystroke"));
  if (activity.length === 0 && moves > 0) activity.push("mouse movement");
  if (activity.length > 0) parts.push(activity.join(", "));

  const appPhrases: string[] = [];
  for (const [app, t] of perApp) {
    if (t.keys > 0) appPhrases.push(`typed in ${app}`);
    else if (t.clicks > 0) appPhrases.push(`clicked in ${app}`);
    else if (t.scrolls > 0) appPhrases.push(`scrolled in ${app}`);
  }
  if (appPhrases.length > 0) parts.push(appPhrases.join(", "));

  return `${parts.join(". ")}.`;
}
