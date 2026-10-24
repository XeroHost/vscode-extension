import * as vscode from 'vscode';

export type OriginCheck = { ok: true; origin: string } | { ok: false; reason: string };

/**
 * A panel origin is accepted only over https, or over plain http when it points at the
 * local machine (development panels). Anything else would send the API key in clear text
 * or to a place we cannot vouch for.
 */
export function checkOrigin(value: string): OriginCheck {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, reason: vscode.l10n.t('Not a valid URL') };
  }

  if (url.username || url.password) {
    return { ok: false, reason: vscode.l10n.t('The URL must not contain credentials') };
  }

  if (url.protocol === 'https:') {
    return { ok: true, origin: url.origin };
  }

  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol === 'http:' && local) {
    return { ok: true, origin: url.origin };
  }

  return { ok: false, reason: vscode.l10n.t('Only https:// panels are supported (http:// only for localhost)') };
}

export function isServerId(value: string): boolean {
  return /^[A-Za-z0-9-]{8,36}$/.test(value);
}
