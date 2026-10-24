import * as vscode from 'vscode';
import pageStrings from './pageStrings.json';

export type PageKey = keyof (typeof pageStrings)['en'];

export interface CallbackPageOptions {
  heading: PageKey;
  message: PageKey;
  tone: 'success' | 'error';
  /** One of the supported language ids (see `pickLanguage`). */
  language: string;
}

const PAGE_LANGUAGES = Object.keys(pageStrings);
const HTML_LANG: Record<string, string> = { 'pt-br': 'pt-BR', 'zh-cn': 'zh-CN' };

/** Maps one language tag ("pt-BR", "zh-Hans-CN", "es-419", "ES") to a supported language id, or null. */
function matchLanguage(tag: string): string | null {
  const lower = tag.trim().toLowerCase().replaceAll('_', '-');
  if (lower === '' || lower === '*') {
    return null;
  }
  if (lower === 'zh' || lower.startsWith('zh-')) {
    return lower.includes('tw') || lower.includes('hk') || lower.includes('hant') ? null : 'zh-cn';
  }
  const primary = lower.split('-')[0];
  if (primary === 'pt') {
    return 'pt-br';
  }
  return PAGE_LANGUAGES.includes(primary) ? primary : null;
}

/**
 * Picks the page language from an Accept-Language header (highest q first), falling back to the
 * language VS Code is displayed in, and finally to English.
 */
export function pickLanguage(acceptLanguage: string | undefined, fallback: string = vscode.env.language): string {
  const ranked = (acceptLanguage ?? '')
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.split(';');
      const q = params.map((p) => /^\s*q\s*=\s*([0-9.]+)/.exec(p)?.[1]).find(Boolean);
      return { tag, q: q === undefined ? 1 : Number(q), index };
    })
    .filter((entry) => entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);

  for (const { tag } of ranked) {
    const match = matchLanguage(tag);
    if (match) {
      return match;
    }
  }
  return matchLanguage(fallback) ?? 'en';
}

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" viewBox="0 0 461 458" fill="#ff0000"><polygon points="38,15 194,112 194,230 38,133"/><polygon points="38,326 194,230 194,347 38,442"/><polygon points="422,15 266,112 266,230 422,133"/><polygon points="422,326 266,230 266,347 422,442"/></svg>`;

const STYLE = `
:root { color-scheme: light dark; --bg: #f4f4f5; --text: #111; --muted: #6b6b73; --error-bg: #ffe3e3; --error: #b42318; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0a0a0a; --text: #e6e6e6; --muted: #8a8a93; --error-bg: rgba(250, 82, 82, 0.15); --error: #ffa8a8; }
}
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 16px/1.55 system-ui, sans-serif; }
main { width: 100%; max-width: 400px; }
header { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; font-weight: 700; }
header svg { width: 40px; height: 40px; }
h1 { margin: 0 0 8px; font-size: 24px; line-height: 1.3; }
p { margin: 0; }
.message { color: var(--muted); }
.alert { padding: 14px 16px; border-radius: 8px; background: var(--error-bg); color: var(--error); font-size: 14px; }
.hint { margin-top: 16px; color: var(--muted); font-size: 14px; }
`;

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => HTML_ESCAPES[character]);
}

export function callbackPage(options: CallbackPageOptions): string {
  const strings = (pageStrings as Record<string, Record<PageKey, string>>)[options.language] ?? pageStrings.en;
  const heading = escapeHtml(strings[options.heading]);
  const message = escapeHtml(strings[options.message]);
  const body =
    options.tone === 'error'
      ? `<div class="alert" role="alert">${message}</div>`
      : `<p class="message">${message}</p>`;

  // The key travels in the query string of this very page: drop it from the address bar and history.
  return `<!doctype html>
<html lang="${HTML_LANG[options.language] ?? options.language}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <meta http-equiv="content-security-policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
    <title>${heading} - XeroHost</title>
    <style>${STYLE}</style>
  </head>
  <body>
    <main>
      <header>${LOGO}<span>XeroHost</span></header>
      <h1>${heading}</h1>
      ${body}
      <p class="hint">${escapeHtml(strings.hint)}</p>
    </main>
    <script>history.replaceState({}, '', '/');</script>
  </body>
</html>`;
}
