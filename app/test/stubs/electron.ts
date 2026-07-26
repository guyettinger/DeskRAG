/**
 * Minimal electron stub so main-process modules can be unit-tested under Node.
 * Only the surface SettingsStore and friends actually touch.
 */

let encryptionAvailable = true;

export const safeStorage = {
  isEncryptionAvailable: () => encryptionAvailable,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => b.toString("utf8").replace(/^enc:/, ""),
};

export const app = {
  getPath: () => "/tmp/deskrag-test",
};

/** Test hook: simulate a machine with no keychain, where keys must not persist. */
export function __setEncryptionAvailable(v: boolean): void {
  encryptionAvailable = v;
}
