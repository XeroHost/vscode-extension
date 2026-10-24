import * as vscode from 'vscode';

/** Localized label for a power state reported by Wings. */
export function stateLabel(state: string): string {
  switch (state) {
    case 'offline':
      return vscode.l10n.t('Offline');
    case 'running':
      return vscode.l10n.t('Running');
    case 'starting':
      return vscode.l10n.t('Starting');
    case 'stopping':
      return vscode.l10n.t('Stopping');
    default:
      return state;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 'B';
  for (const next of units) {
    value /= 1024;
    unit = next;
    if (value < 1024) {
      break;
    }
  }
  return `${value.toFixed(1)} ${unit}`;
}
