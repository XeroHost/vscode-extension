import * as vscode from 'vscode';
import { log } from './log.ts';
import { checkOrigin, isServerId } from './origin.ts';
import { serverUri } from './serverUri.ts';
import { type MountedServer, mountWillReload, openServerFolder, shortId } from './servers.ts';
import type { Session } from './session.ts';

export const PENDING_CONSOLE_KEY = 'xerohost.pendingConsole';
export const PENDING_EXPLORER_KEY = 'xerohost.pendingExplorer';
export const PENDING_FILE_KEY = 'xerohost.pendingFile';

function isTruthy(value: string | null): boolean {
  return value !== null && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function normalizeFilePath(path: string): string | null {
  const trimmed = path.trim();
  if (trimmed === '' || CONTROL_CHARS.test(trimmed) || trimmed.split('/').includes('..')) {
    return null;
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export async function openFile(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.commands.executeCommand('vscode.open', uri);
  } catch (err) {
    log.warn(`uri handler: could not open file ${uri.toString()}: ${err}`);
  }
}

/** Handles vscode://xerohost.xerohost/open?origin=&server=&console=1&file= */
export class XeroHostUriHandler implements vscode.UriHandler {
  constructor(
    private readonly session: Session,
    private readonly globalState: vscode.Memento,
    private readonly openConsole: (server: MountedServer) => void,
  ) {}

  async handleUri(uri: vscode.Uri): Promise<void> {
    if (uri.path !== '/open') {
      return;
    }

    const params = new URLSearchParams(uri.query);
    const checked = checkOrigin(params.get('origin') ?? '');
    const serverId = params.get('server') ?? '';

    if (!checked.ok || !isServerId(serverId)) {
      log.error(`uri handler: rejected link (${checked.ok ? 'bad server id' : checked.reason})`);
      vscode.window.showErrorMessage(
        checked.ok
          ? vscode.l10n.t('XeroHost: invalid open link.')
          : vscode.l10n.t('XeroHost: invalid open link ({0}).', checked.reason),
      );
      return;
    }

    const fileParam = params.get('file');
    const file = fileParam ? normalizeFilePath(fileParam) : null;
    if (fileParam && !file) {
      vscode.window.showWarningMessage(
        vscode.l10n.t('XeroHost: the link has an invalid file path; opening the server only.'),
      );
    }

    log.info(`uri handler: open ${serverId} on ${checked.origin}`);

    const client =
      (await this.session.clientIfSignedIn(checked.origin)) ?? (await this.session.provisionSignIn(checked.origin, true));
    if (!client) {
      return;
    }

    let server: MountedServer;
    try {
      const found = await client.getServer(serverId);
      server = { origin: client.origin, uuid: found.uuid, name: found.name || shortId(found.uuid) };
    } catch (err) {
      vscode.window.showErrorMessage(vscode.l10n.t('XeroHost: could not open server {0} ({1}).', serverId, String(err)));
      return;
    }

    await this.openServer(server, isTruthy(params.get('console')), file);
  }

  private async openServer(target: MountedServer, wantConsole: boolean, file: string | null): Promise<void> {
    const fileUri = file ? serverUri(target.origin, target.uuid, file) : undefined;

    const willReload = mountWillReload(target);
    if (wantConsole) {
      await this.globalState.update(PENDING_CONSOLE_KEY, target);
    }
    if (fileUri) {
      await this.globalState.update(PENDING_FILE_KEY, fileUri.toString());
    }
    if (willReload) {
      await this.globalState.update(PENDING_EXPLORER_KEY, true);
    }

    await openServerFolder(target);

    if (willReload) {
      return;
    }

    await vscode.commands.executeCommand('workbench.view.explorer');
    if (fileUri) {
      await this.globalState.update(PENDING_FILE_KEY, undefined);
      await openFile(fileUri);
    }
    if (wantConsole) {
      await this.globalState.update(PENDING_CONSOLE_KEY, undefined);
      this.openConsole(target);
    }
  }
}
