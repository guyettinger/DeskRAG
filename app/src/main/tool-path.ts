/**
 * PATH repair for spawned CLI tools (ffmpeg, whisper-cli).
 *
 * A packaged macOS app is launched by launchd, not a shell, so it inherits a
 * minimal PATH ("/usr/bin:/bin:/usr/sbin:/sbin") with no Homebrew in it. Every
 * capture/transcribe subprocess is looked up by bare name, so audio recording
 * and whisper appear "not installed" in a packaged build while working fine in
 * a terminal-launched dev run — the single most confusing failure mode here.
 *
 * Fix: prepend the well-known local install prefixes. Existing entries win
 * (they are not re-added), and a user-set PATH still takes precedence because
 * inherited entries stay ahead of the ones added here.
 */

/** Homebrew (arm64 + x86_64), MacPorts, and the usual /usr/local install root. */
const DARWIN_PREFIXES = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/opt/local/bin",
  "/usr/local/sbin",
];

export function toolPath(current: string | undefined, platform: string): string {
  const entries = (current ?? "").split(":").filter((p) => p.length > 0);
  if (platform !== "darwin") return entries.join(":");
  const extra = DARWIN_PREFIXES.filter((p) => !entries.includes(p));
  return [...entries, ...extra].join(":");
}

/** Applies toolPath() to process.env in place. Safe to call more than once. */
export function ensureToolPath(): void {
  process.env["PATH"] = toolPath(process.env["PATH"], process.platform);
}
