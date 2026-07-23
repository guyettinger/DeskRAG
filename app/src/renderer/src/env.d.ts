/// <reference types="vite/client" />
import type { DeskRagApi } from "@shared/types";

declare global {
  interface Window {
    deskrag: DeskRagApi;
  }
}

export {};
