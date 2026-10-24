import * as vscode from 'vscode';
import { ConsolePseudoterminal, openConsoleTerminal, trackConsoleTerminals } from './console/pseudoterminal.ts';
import { registerFileActions } from './files/actions.ts';
import { XeroHostFileSystem } from './fs/fileSystemProvider.ts';
import { log } from './log.ts';
import { SCHEME } from './serverUri.ts';
import {
  type MountedServer,
  mountedServers,
  openServerFolder,
  pickMountedServer,
  pickServer,
} from './servers.ts';
import { Session } from './session.ts';
import { ServerStatusBar } from './statusBar.ts';
import { openFile, PENDING_CONSOLE_KEY, PENDING_EXPLORER_KEY, PENDING_FILE_KEY, XeroHostUriHandler } from './uriHandler.ts';
import { WingsSocketHub } from './wings/socketHub.ts';

export function activate(context: vscode.ExtensionContext): void {
  const session = new Session(context.secrets);
  const socketHub = new WingsSocketHub(session);
  const statusBar = new ServerStatusBar(session, socketHub);
  const fs = new XeroHostFileSystem(session);

  const openConsoleFor = (server: MountedServer): void => {
    openConsoleTerminal(socketHub, server);
    statusBar.pin(server.origin, server.uuid, server.name);
  };

  context.subscriptions.push(
    log,
    statusBar,
    { dispose: () => socketHub.dispose() },
    trackConsoleTerminals(),

    vscode.workspace.registerFileSystemProvider(SCHEME, fs, { isCaseSensitive: true }),
    vscode.window.registerUriHandler(new XeroHostUriHandler(session, context.globalState, openConsoleFor)),
    ...registerFileActions(session, fs),

    vscode.commands.registerCommand('xerohost.signIn', () => session.promptSignIn()),

    vscode.commands.registerCommand('xerohost.signOut', async () => {
      const origins = await session.origins();
      if (origins.length === 0) {
        vscode.window.showInformationMessage('XeroHost: not signed in.');
        return;
      }

      const ALL = 'All panels';
      const picked =
        origins.length === 1
          ? origins[0]
          : await vscode.window.showQuickPick([...origins, ALL], { title: 'XeroHost: sign out of which panel?' });
      if (!picked) {
        return;
      }

      await session.signOut(picked === ALL ? undefined : picked);
      vscode.window.showInformationMessage(
        picked === ALL ? 'XeroHost: signed out of all panels.' : `XeroHost: signed out of ${picked}.`,
      );
    }),

    vscode.commands.registerCommand('xerohost.openServer', async () => {
      const picked = await pickServer(session);
      if (picked) {
        const server = { origin: picked.origin, uuid: picked.server.uuid, name: picked.server.name };
        statusBar.pin(server.origin, server.uuid, server.name);
        await openServerFolder(server);
      }
    }),

    vscode.commands.registerCommand('xerohost.openConsole', async () => {
      const server = await pickMountedServer(session);
      if (server) {
        openConsoleFor(server);
      }
    }),

    vscode.commands.registerCommand('xerohost.powerAction', () => statusBar.showPowerActions()),

    vscode.window.registerTerminalProfileProvider('xerohost.console', {
      async provideTerminalProfile() {
        const server = await pickMountedServer(session);
        if (!server) {
          throw new Error('No server selected.');
        }
        statusBar.pin(server.origin, server.uuid, server.name);
        return new vscode.TerminalProfile({
          name: `Console: ${server.name}`,
          pty: new ConsolePseudoterminal(socketHub, server),
          iconPath: new vscode.ThemeIcon('server-environment'),
        });
      },
    }),
  );

  void (async () => {
    await resumePendingExplorer(context);
    await resumePendingFile(context);
    await resumePendingConsole(context, openConsoleFor);
  })();

  log.info('activated');
}

async function resumePendingExplorer(context: vscode.ExtensionContext): Promise<void> {
  if (!context.globalState.get<boolean>(PENDING_EXPLORER_KEY)) {
    return;
  }
  await context.globalState.update(PENDING_EXPLORER_KEY, undefined);
  await vscode.commands.executeCommand('workbench.view.explorer');
}

async function resumePendingFile(context: vscode.ExtensionContext): Promise<void> {
  const stored = context.globalState.get<string>(PENDING_FILE_KEY);
  if (!stored) {
    return;
  }
  await context.globalState.update(PENDING_FILE_KEY, undefined);

  const uri = vscode.Uri.parse(stored);
  const mounted = (vscode.workspace.workspaceFolders ?? []).some(
    (folder) => folder.uri.scheme === SCHEME && folder.uri.authority === uri.authority,
  );
  if (mounted) {
    await openFile(uri);
  }
}

async function resumePendingConsole(
  context: vscode.ExtensionContext,
  openConsoleFor: (server: MountedServer) => void,
): Promise<void> {
  const pending = context.globalState.get<MountedServer>(PENDING_CONSOLE_KEY);
  if (!pending) {
    return;
  }

  const isMounted = mountedServers().some(
    (s) => s.origin === pending.origin && s.uuid.toLowerCase() === pending.uuid.toLowerCase(),
  );
  if (!isMounted) {
    return;
  }

  await context.globalState.update(PENDING_CONSOLE_KEY, undefined);
  openConsoleFor(pending);
}

export function deactivate(): void {
  log.info('deactivated');
}
