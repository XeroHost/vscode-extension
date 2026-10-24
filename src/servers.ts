import * as vscode from 'vscode';
import type { Server } from './api/types.ts';
import { log } from './log.ts';
import { isServerId } from './origin.ts';
import { decodeAuthority, SCHEME, serverUri } from './serverUri.ts';
import type { Session } from './session.ts';

export interface MountedServer {
  origin: string;
  uuid: string;
  name: string;
}

export function shortId(uuid: string): string {
  return uuid.slice(0, 8);
}

export async function pickServer(session: Session): Promise<{ origin: string; server: Server } | null> {
  const origin = await pickPanel(session);
  if (!origin) {
    return null;
  }

  const client = await session.client(origin);
  const picked = await vscode.window.showQuickPick(
    loadServers(client.origin, () => client.listServers()),
    {
      title: vscode.l10n.t('XeroHost: select a server ({0})', client.origin),
      placeHolder: vscode.l10n.t('Search servers by name...'),
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  if (!picked) {
    return null;
  }
  if (picked.server) {
    return { origin: client.origin, server: picked.server };
  }

  // Accounts with access that is not listed (for example staff) can still open a server by its id.
  const id = await vscode.window.showInputBox({
    title: vscode.l10n.t('XeroHost: server ID'),
    prompt: vscode.l10n.t('The server identifier shown in the panel (8 characters) or its UUID'),
    validateInput: (value) => (isServerId(value.trim()) ? null : vscode.l10n.t('Not a valid server ID')),
  });
  if (!id) {
    return null;
  }
  try {
    return { origin: client.origin, server: await client.getServer(id.trim()) };
  } catch (err) {
    vscode.window.showErrorMessage(vscode.l10n.t('XeroHost: could not open server {0} ({1}).', id.trim(), String(err)));
    return null;
  }
}

interface ServerPick extends vscode.QuickPickItem {
  server?: Server;
}

async function loadServers(origin: string, list: () => Promise<Server[]>): Promise<ServerPick[]> {
  const manual: ServerPick = { label: vscode.l10n.t('$(edit) Enter a server ID...'), alwaysShow: true };
  try {
    const servers = await list();
    return [
      ...servers.map((server) => ({
        label: server.name,
        description: server.identifier,
        detail: server.description || undefined,
        server,
      })),
      manual,
    ];
  } catch (err) {
    log.warn(`failed to list servers for ${origin}: ${err}`);
    vscode.window.showErrorMessage(vscode.l10n.t('XeroHost: could not list your servers ({0}).', String(err)));
    return [manual];
  }
}

async function pickPanel(session: Session): Promise<string | undefined> {
  const origins = await session.origins();
  if (origins.length === 0) {
    return (await session.promptSignIn())?.origin;
  }
  if (origins.length === 1) {
    return origins[0];
  }

  const ADD = vscode.l10n.t('$(add) Sign in to another panel...');
  const picked = await vscode.window.showQuickPick([...origins, ADD], { title: vscode.l10n.t('XeroHost: select a panel') });
  if (!picked) {
    return undefined;
  }
  return picked === ADD ? (await session.promptSignIn())?.origin : picked;
}

export function mountedServers(): MountedServer[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === SCHEME)
    .map((folder) => {
      const { origin, server } = decodeAuthority(folder.uri.authority);
      return { origin, uuid: server, name: folder.name || shortId(server) };
    });
}

export async function pickMountedServer(session: Session): Promise<MountedServer | null> {
  const mounted = mountedServers();

  if (mounted.length === 0) {
    const picked = await pickServer(session);
    return picked ? { origin: picked.origin, uuid: picked.server.uuid, name: picked.server.name } : null;
  }

  if (mounted.length === 1) {
    return mounted[0];
  }

  const picked = await vscode.window.showQuickPick(
    mounted.map((server) => ({ label: server.name, description: server.uuid, detail: server.origin, server })),
    { title: vscode.l10n.t('XeroHost: select a mounted server'), matchOnDescription: true, matchOnDetail: true },
  );
  return picked?.server ?? null;
}

export function isMounted(server: MountedServer): boolean {
  const uri = serverUri(server.origin, server.uuid).toString();
  return (vscode.workspace.workspaceFolders ?? []).some((folder) => folder.uri.toString() === uri);
}

export function mountWillReload(server: MountedServer): boolean {
  return !isMounted(server) && (vscode.workspace.workspaceFolders ?? []).length <= 1;
}

export async function openServerFolder(server: MountedServer): Promise<void> {
  const uri = serverUri(server.origin, server.uuid);
  const existing = vscode.workspace.workspaceFolders ?? [];

  if (isMounted(server)) {
    return;
  }

  log.info(`mount ${uri.toString()}: adding "${server.name}" at index ${existing.length}`);
  if (vscode.workspace.updateWorkspaceFolders(existing.length, 0, { uri, name: server.name })) {
    return;
  }

  if (existing.length === 0) {
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
    return;
  }

  vscode.window.showErrorMessage(
    vscode.l10n.t(
      'XeroHost: could not add {0} to the workspace. Check the XeroHost output channel for details.',
      server.name,
    ),
  );
}
