import * as vscode from 'vscode';
import { ApiError, type PanelClient } from '../api/client.ts';
import type { FileEntry } from '../api/types.ts';
import { log } from '../log.ts';
import { joinPath, splitPath } from '../paths.ts';
import { refOf, SCHEME, type ServerRef, serverUri } from '../serverUri.ts';
import type { Session } from '../session.ts';

const CACHE_TTL_MS = 2_500;
const MAX_INLINE_WRITE_BYTES = 1024 * 1024;
const MIB = 1024 * 1024;

interface CachedListing {
  at: number;
  entries: FileEntry[];
}

function toFileType(entry: FileEntry): vscode.FileType {
  let type = entry.is_file ? vscode.FileType.File : vscode.FileType.Directory;
  if (entry.is_symlink) {
    type |= vscode.FileType.SymbolicLink;
  }
  return type;
}

function relative(path: string): string {
  return path.replace(/^\/+/, '');
}

function translateError(err: unknown, uri: vscode.Uri): Error {
  if (err instanceof vscode.FileSystemError || err instanceof vscode.CancellationError) {
    return err;
  }
  if (err instanceof ApiError) {
    switch (err.status) {
      case 401:
      case 403:
        return vscode.FileSystemError.NoPermissions(uri);
      case 404:
        return vscode.FileSystemError.FileNotFound(uri);
      case 413:
        return vscode.FileSystemError.Unavailable(`${uri.path}: the file is too large for the panel`);
    }
    return vscode.FileSystemError.Unavailable(`${uri.path}: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

function downloadThresholdBytes(): number {
  const configured = vscode.workspace.getConfiguration('xerohost').get<number>('files.downloadThresholdMiB', 4);
  return Math.max(1, configured) * MIB;
}

export class XeroHostFileSystem implements vscode.FileSystemProvider {
  private readonly cache = new Map<string, CachedListing>();

  private readonly didChangeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.didChangeEmitter.event;

  constructor(private readonly session: Session) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  private cacheKey(ref: ServerRef, directory: string): string {
    return `${ref.origin}\0${ref.server}\0${directory}`;
  }

  private async listCached(ref: ServerRef, directory: string): Promise<FileEntry[]> {
    const key = this.cacheKey(ref, directory);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return hit.entries;
    }

    log.trace(`fs list ${key}`);
    const client = await this.session.client(ref.origin);
    const entries = await client.listDirectory(ref.server, directory);
    this.cache.set(key, { at: Date.now(), entries });
    return entries;
  }

  /**
   * Existence is answered by listing the parent directory: this Wings answers 500, not 404, for
   * paths that do not exist, so a status code cannot tell "missing" from "broken".
   */
  private async lookup(ref: ServerRef, path: string): Promise<FileEntry | null> {
    const { parent, name } = splitPath(path);
    try {
      const entries = await this.listCached(ref, parent);
      return entries.find((e) => e.name === name) ?? null;
    } catch (err) {
      if (err instanceof ApiError && err.status !== 401 && err.status !== 403) {
        return null;
      }
      throw err;
    }
  }

  private invalidate(ref: ServerRef, directory: string): void {
    this.cache.delete(this.cacheKey(ref, directory));
  }

  invalidatePath(ref: ServerRef, directory: string): void {
    this.invalidate(ref, directory);
    this.didChangeEmitter.fire([
      { type: vscode.FileChangeType.Changed, uri: serverUri(ref.origin, ref.server, directory) },
    ]);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    if (uri.path === '/' || uri.path === '') {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }

    try {
      const entry = await this.lookup(refOf(uri), uri.path);
      if (!entry) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }

      return {
        type: toFileType(entry),
        ctime: Date.parse(entry.created_at) || 0,
        mtime: Date.parse(entry.modified_at) || 0,
        size: entry.size,
      };
    } catch (err) {
      throw translateError(err, uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    try {
      const entries = await this.listCached(refOf(uri), uri.path || '/');
      return entries.map((entry) => [entry.name, toFileType(entry)]);
    } catch (err) {
      throw translateError(err, uri);
    }
  }

  private async readBytes(client: PanelClient, server: string, path: string, size: number | undefined): Promise<Uint8Array> {
    if (size !== undefined && size > downloadThresholdBytes()) {
      return client.downloadFile(server, path);
    }

    try {
      return await client.readFile(server, path);
    } catch (err) {
      // The contents endpoint refuses files above the panel's editing limit.
      if (err instanceof ApiError && (err.status === 400 || err.status === 413)) {
        return client.downloadFile(server, path);
      }
      throw err;
    }
  }

  private async writeBytes(client: PanelClient, server: string, path: string, content: Uint8Array): Promise<void> {
    if (content.byteLength <= MAX_INLINE_WRITE_BYTES) {
      await client.writeFile(server, path, content);
      return;
    }

    const { parent, name } = splitPath(path);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `XeroHost: uploading ${name}` },
      () => client.uploadFile(server, parent, name, content),
    );
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    log.trace(`fs read ${uri.toString()}`);
    const ref = refOf(uri);

    try {
      const entry = await this.lookup(ref, uri.path);
      if (!entry) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      if (!entry.is_file) {
        throw vscode.FileSystemError.FileIsADirectory(uri);
      }

      const client = await this.session.client(ref.origin);
      return await this.readBytes(client, ref.server, uri.path, entry.size);
    } catch (err) {
      log.error(`fs read ${uri.toString()} failed: ${err}`);
      throw translateError(err, uri);
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    const ref = refOf(uri);
    const { parent } = splitPath(uri.path);

    try {
      this.invalidate(ref, parent);
      const existing = await this.lookup(ref, uri.path);
      if (existing && !options.overwrite) {
        throw vscode.FileSystemError.FileExists(uri);
      }
      if (!existing && !options.create) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      if (existing && !existing.is_file) {
        throw vscode.FileSystemError.FileIsADirectory(uri);
      }

      const client = await this.session.client(ref.origin);
      await this.writeBytes(client, ref.server, uri.path, content);

      this.invalidate(ref, parent);
      this.didChangeEmitter.fire([
        { type: existing ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri },
      ]);
    } catch (err) {
      log.error(`fs write ${uri.toString()} failed: ${err}`);
      throw translateError(err, uri);
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const ref = refOf(uri);
    const { parent, name } = splitPath(uri.path);
    try {
      const client = await this.session.client(ref.origin);
      await client.createDirectory(ref.server, parent, name);
    } catch (err) {
      throw translateError(err, uri);
    }

    this.invalidate(ref, parent);
    this.didChangeEmitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }

  async delete(uri: vscode.Uri): Promise<void> {
    const ref = refOf(uri);
    const { parent, name } = splitPath(uri.path);
    try {
      const client = await this.session.client(ref.origin);
      await client.delete(ref.server, parent, [name]);
    } catch (err) {
      throw translateError(err, uri);
    }

    this.invalidate(ref, parent);
    this.invalidate(ref, uri.path);
    this.didChangeEmitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    if (oldUri.authority !== newUri.authority) {
      throw vscode.FileSystemError.Unavailable('Cannot rename across servers.');
    }

    const ref = refOf(oldUri);
    const oldParent = splitPath(oldUri.path).parent;
    const newParent = splitPath(newUri.path).parent;

    try {
      this.invalidate(ref, newParent);
      const target = await this.lookup(ref, newUri.path);
      const client = await this.session.client(ref.origin);

      if (target) {
        if (!options.overwrite) {
          throw vscode.FileSystemError.FileExists(newUri);
        }
        await client.delete(ref.server, newParent, [splitPath(newUri.path).name]);
      }

      await client.rename(ref.server, '/', relative(oldUri.path), relative(newUri.path));
    } catch (err) {
      throw translateError(err, oldUri);
    }

    this.invalidate(ref, oldParent);
    this.invalidate(ref, newParent);
    this.invalidate(ref, oldUri.path);
    this.didChangeEmitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }

  /**
   * Copies by reading and writing: the panel's copy endpoint can only duplicate a file next to
   * itself with a generated name, which is not what a drag-and-drop or paste asks for.
   */
  async copy(source: vscode.Uri, destination: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    if (source.scheme !== SCHEME || destination.scheme !== SCHEME) {
      throw vscode.FileSystemError.Unavailable('Only xerohost:// URIs are supported.');
    }

    const srcRef = refOf(source);
    const destRef = refOf(destination);
    const destParent = splitPath(destination.path).parent;

    try {
      this.invalidate(destRef, destParent);
      const entry = await this.lookup(srcRef, source.path);
      if (!entry) {
        throw vscode.FileSystemError.FileNotFound(source);
      }

      const existing = await this.lookup(destRef, destination.path);
      const destClient = await this.session.client(destRef.origin);
      if (existing) {
        if (!options.overwrite) {
          throw vscode.FileSystemError.FileExists(destination);
        }
        await destClient.delete(destRef.server, destParent, [splitPath(destination.path).name]);
      }

      const srcClient = await this.session.client(srcRef.origin);
      await this.copyEntry(srcClient, srcRef.server, destClient, destRef.server, source.path, destination.path, entry);
    } catch (err) {
      log.error(`fs copy ${source.toString()} -> ${destination.toString()} failed: ${err}`);
      throw translateError(err, destination);
    }

    this.invalidate(destRef, destParent);
    this.didChangeEmitter.fire([{ type: vscode.FileChangeType.Created, uri: destination }]);
  }

  private async copyEntry(
    srcClient: PanelClient,
    srcServer: string,
    destClient: PanelClient,
    destServer: string,
    srcPath: string,
    destPath: string,
    entry: FileEntry,
  ): Promise<void> {
    if (entry.is_file) {
      const bytes = await this.readBytes(srcClient, srcServer, srcPath, entry.size);
      await this.writeBytes(destClient, destServer, destPath, bytes);
      return;
    }

    const dest = splitPath(destPath);
    await destClient.createDirectory(destServer, dest.parent, dest.name);

    for (const child of await srcClient.listDirectory(srcServer, srcPath)) {
      await this.copyEntry(
        srcClient,
        srcServer,
        destClient,
        destServer,
        joinPath(srcPath, child.name),
        joinPath(destPath, child.name),
        child,
      );
    }
  }
}
