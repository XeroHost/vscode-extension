import * as vscode from 'vscode';

export interface CallbackPageOptions {
  heading: string;
  message: string;
  tone: 'success' | 'error';
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

function hint(): string {
  return vscode.env.language.startsWith('es')
    ? 'Puedes cerrar esta pestaña y volver a tu editor.'
    : 'You can close this tab and return to your editor.';
}

export function callbackPage(options: CallbackPageOptions): string {
  const heading = escapeHtml(options.heading);
  const message = escapeHtml(options.message);
  const body =
    options.tone === 'error'
      ? `<div class="alert" role="alert">${message}</div>`
      : `<p class="message">${message}</p>`;

  // The key travels in the query string of this very page: drop it from the address bar and history.
  return `<!doctype html>
<html lang="${vscode.env.language.startsWith('es') ? 'es' : 'en'}">
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
      <p class="hint">${hint()}</p>
    </main>
    <script>history.replaceState({}, '', '/');</script>
  </body>
</html>`;
}
