// Image-service names must never reach the user (the provider may change), so
// any error/refusal text coming back from the Theme Service is scrubbed here
// before it is displayed or stored.

const PROVIDER_PATTERNS: RegExp[] = [
  /\bOpenAI(?:'s|’s)?(?:[\s-]+GPT[\s-]*Image(?:[\s-]*\d[\d.]*)?(?:[\s-]*mini)?)?(?![\w-])/gi,
  /\bGPT[\s-]*Image(?:[\s-]*\d[\d.]*)?(?:[\s-]*mini)?(?![\w-])/gi,
  /\bgpt-image(?:-[\w.]+)*(?![\w-])/gi,
  /\bDALL[·.\-\s]?E(?:[\s-]*\d+)?\b/gi,
  /\b(?:Google\s+)?Gemini(?:[\s-]+(?:\d[\w.]*|flash|pro|image|preview))*(?![\w-])/gi,
  /\b(?:Google\s+)?Imagen(?:[\s-]*\d+)?\b/gi,
  /\bnano[\s-]?banana\b/gi,
  /\bStability(?:\s*AI)?\b/gi,
  /\bStable\s+Diffusion\b/gi,
  /\bMidjourney(?![\w-])/gi,
  /\bFlux(?:\.\d+)?(?![\w-])/gi,
  /\bIdeogram(?![\w-])/gi,
  /\bFirefly(?![\w-])/gi,
];

/** Replaces known image-provider names in a Theme Service message with "the image provider". */
export function sanitizeImageProviderText(text: string): string;
export function sanitizeImageProviderText(text: string | undefined): string | undefined;
export function sanitizeImageProviderText(text: string | undefined): string | undefined {
  if (!text) return text;
  let out = text;
  for (const re of PROVIDER_PATTERNS) out = out.replace(re, (m) => (/['’]s$/.test(m) && !/GPT/i.test(m) ? "the image provider's" : "the image provider"));
  out = out.replace(/(?:the image provider(?:['’]s)?\s*){2,}/gi, (m) => (/['’]s/.test(m) ? "the image provider's " : "the image provider "));
  out = out.replace(/\b(the image provider(?:'s)?)\s+API\b/gi, "$1");
  out = out.replace(/(^|[.!?]\s+)the image provider/g, (_m, p: string) => `${p}The image provider`);
  return out.replace(/\s{2,}/g, " ").trim();
}
