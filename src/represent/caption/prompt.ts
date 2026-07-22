/** Shared captioning instruction for the VLM caption providers. */
export const CAPTION_SYSTEM =
  "You caption desktop screenshots for a searchable activity log. Describe what is " +
  "on screen concisely and factually: the application, the visible UI, and the user's " +
  "likely task. One or two sentences. No preamble.";

export function captionPrompt(context?: string): string {
  const base =
    "Caption this desktop screen (multiple sampled frames from the same moment).";
  return context ? `${base}\nStructured signal for context: ${context}` : base;
}
