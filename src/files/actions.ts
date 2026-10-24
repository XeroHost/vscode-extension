import * as vscode from 'vscode';
import { log } from '../log.ts';
import { basename, dirname } from '../paths.ts';
import { refOf, SCHEME } from '../serverUri.ts';
import type { Session } from '../session.ts';
import type { XeroHostFileSystem } from '../fs/fileSystemProvider.ts';

function selection(uri: vscode.Uri | undefined, uris: vscode.Uri[] | undefined): vscode.Uri[] {
  const all = uris && uris.length > 0 ? uris : uri ? [uri] : [];
  return all.filter((candidate) => candidate.scheme === SCHEME);
}

function withProgress<T>(title: string, task: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);
}

async function compress(session: Session, fs: XeroHostFileSystem, targets: vscode.Uri[]): Promise<void> {
  const root = dirname(targets[0].path);
  if (targets.some((target) => dirname(target.path) !== root)) {
    vscode.window.showErrorMessage('XeroHost: select files from a single folder to compress.');
    return;
  }

  const ref = refOf(targets[0]);
  try {
    const client = await session.client(ref.origin);
    const archive = await withProgress('XeroHost: compressing...', () =>
      client.compress(
        ref.server,
        root,
        targets.map((target) => basename(target.path)),
      ),
    );
    fs.invalidatePath(ref, root);
    vscode.window.setStatusBarMessage(`XeroHost: created ${archive}`, 5000);
  } catch (err) {
    log.error(`compress ${root} failed: ${err}`);
    vscode.window.showErrorMessage(`XeroHost: could not create the archive: ${err}`);
  }
}

async function decompress(session: Session, fs: XeroHostFileSystem, targets: vscode.Uri[]): Promise<void> {
  for (const target of targets) {
    const ref = refOf(target);
    const root = dirname(target.path);
    try {
      const client = await session.client(ref.origin);
      await withProgress(`XeroHost: extracting ${basename(target.path)}...`, () =>
        client.decompress(ref.server, root, basename(target.path)),
      );
      fs.invalidatePath(ref, root);
    } catch (err) {
      log.error(`decompress ${target.path} failed: ${err}`);
      vscode.window.showErrorMessage(`XeroHost: could not extract ${basename(target.path)}: ${err}`);
    }
  }
}

export function registerFileActions(session: Session, fs: XeroHostFileSystem): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('xerohost.files.compress', (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const targets = selection(uri, uris);
      return targets.length > 0 ? compress(session, fs, targets) : undefined;
    }),

    vscode.commands.registerCommand('xerohost.files.decompress', (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const targets = selection(uri, uris);
      return targets.length > 0 ? decompress(session, fs, targets) : undefined;
    }),
  ];
}
