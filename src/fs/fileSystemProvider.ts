import * as vscode from 'vscode';
import { ApiError, type PanelClient } from '../api/client.ts';
import type { FileEntry } from '../api/types.ts';
import { log } from '../log.ts';
import { joinPath, splitPath } from '../paths.ts';
import { refOf, SCHEME, type ServerRef, serverUri } from '../serverUri.ts';
import type { Session } from '../session.ts';

const CACHE_TTL_MS = 2_500;
/** Never poll faster than this, whatever the setting says. */
const MIN_POLL_SECONDS = 3;
/** Hard cap of directories listed per cycle; the real cap is also bounded by the request budget below. */
const MAX_DIRS_PER_CYCLE = 20;
/** The panel throttles ~240 requests/min per user: polling stays at or below a quarter of that. */
const POLL_BUDGET_PER_MINUTE = 60;
const MAX_BACKOFF_FACTOR = 8;
/** A directory that failed to list (probably deleted) is left alone for this long. */
const MISSING_DIR_PAUSE_MS = 60_000;
const MAX_INLINE_WRITE_BYTES = 1024 * 1024;
const MIB = 1024 * 1024;

interface CachedListing {
  at: number;
  entries: FileEntry[];
}

interface EntryState {
  isFile: boolean;
  size: number;
  mtime: number;
}

/** What a polled directory looked like the last time we listed it. */
type Snapshot = Map<string, EntryState>;

interface Watcher {
  uri: vscode.Uri;
  recursive: boolean;
}

type PollTarget = ServerRef & { path: string };

function snapshotOf(entries: FileEntry[]): Snapshot {
  return new Map(
    entries.map((entry) => [
      entry.name,
      { isFile: entry.is_file, size: entry.size, mtime: Date.parse(entry.modified_at) || 0 },
    ]),
  );
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

function pollIntervalSeconds(): number {
  const configured = vscode.workspace.getConfiguration('xerohost').get<number>('files.pollIntervalSeconds', 10);
  if (!Number.isFinite(configured) || configured <= 0) {
    return 0;
  }
  return Math.max(MIN_POLL_SECONDS, configured);
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
        return vscode.FileSystemError.Unavailable(vscode.l10n.t('{0}: the file is too large for the panel', uri.path));
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

  private readonly watchers = new Set<Watcher>();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly missingUntil = new Map<string, number>();
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cursor = 0;
  private backoffFactor = 1;
  private polling = false;

  constructor(private readonly session: Session) {
    this.disposables.push(
      this.didChangeEmitter,
      vscode.workspace.onDidChangeConfiguration?.((event) => {
        if (event.affectsConfiguration('xerohost.files.pollIntervalSeconds')) {
          this.schedule();
        }
      }) ?? new vscode.Disposable(() => undefined),
      vscode.window.onDidChangeWindowState?.((state) => {
        if (state.focused && this.watchers.size > 0) {
          // Back from another app: that is exactly when something may have changed on the panel.
          this.backoffFactor = 1;
          this.schedule(1_000);
        }
      }) ?? new vscode.Disposable(() => undefined),
    );
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.watchers.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /** VS Code calls this for workspace roots, expanded explorer folders and open files; we poll what it watches. */
  watch(uri: vscode.Uri, options?: { recursive?: boolean }): vscode.Disposable {
    const watcher: Watcher = { uri, recursive: options?.recursive ?? false };
    this.watchers.add(watcher);
    this.schedule();
    return new vscode.Disposable(() => {
      this.watchers.delete(watcher);
      if (this.watchers.size === 0 && this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      // Baselines of folders nobody watches any more would only turn old history into fake "changes" later.
      for (const key of [...this.snapshots.keys()]) {
        const [origin, server, path] = key.split('\0');
        if (!this.isWatchRelevant({ origin, server }, path)) {
          this.snapshots.delete(key);
        }
      }
    });
  }

  /**
   * "XeroHost: Refresh": forgets everything cached for the server (or all servers) and tells
   * VS Code the root and every directory it has listed changed, so trees re-read them. A diff
   * of the watched directories also fires the precise events that reload open editors.
   */
  async refresh(target?: ServerRef): Promise<void> {
    const matches = (key: string): boolean => !target || key.startsWith(`${target.origin}\0${target.server}\0`);

    const directories = new Map<string, PollTarget>();
    const roots = new Map<string, ServerRef>();
    for (const key of [...this.cache.keys(), ...this.snapshots.keys()]) {
      if (matches(key)) {
        const [origin, server, path] = key.split('\0');
        directories.set(key, { origin, server, path });
        roots.set(`${origin}\0${server}`, { origin, server });
      }
    }
    for (const watcher of this.watchers) {
      const ref = refOf(watcher.uri);
      if (!target || (ref.origin === target.origin && ref.server === target.server)) {
        roots.set(`${ref.origin}\0${ref.server}`, ref);
      }
    }
    if (target) {
      roots.set(`${target.origin}\0${target.server}`, target);
    }
    for (const ref of roots.values()) {
      directories.set(this.cacheKey(ref, '/'), { ...ref, path: '/' });
    }

    for (const key of [...this.cache.keys()]) {
      if (matches(key)) {
        this.cache.delete(key);
      }
    }
    this.missingUntil.clear();

    this.didChangeEmitter.fire(
      [...directories.values()].slice(0, 50).map(({ origin, server, path }) => ({
        type: vscode.FileChangeType.Changed,
        uri: serverUri(origin, server, path),
      })),
    );

    await this.pollOnce({ force: true, target });
  }

  /** Directories to list this cycle: what is watched, plus the parents that hold watched files. */
  private pollTargets(): PollTarget[] {
    const found = new Map<string, PollTarget>();
    const add = (ref: ServerRef, path: string): void => {
      found.set(this.cacheKey(ref, path), { origin: ref.origin, server: ref.server, path });
    };

    for (const watcher of this.watchers) {
      const ref = refOf(watcher.uri);
      if (!ref.origin || !ref.server) {
        continue;
      }
      const path = watcher.uri.path.replace(/\/+$/, '') || '/';
      if (path === '/') {
        add(ref, '/');
        continue;
      }

      // A watch on a file (or on a folder that may be replaced) is answered by its parent...
      const { parent, name } = splitPath(path);
      add(ref, parent);

      // ...and a watched folder is listed too, once its parent's last listing says it is a folder.
      const known = this.snapshots.get(this.cacheKey(ref, parent))?.get(name);
      if (known && !known.isFile) {
        add(ref, path);
      }
    }

    return [...found.values()];
  }

  private schedule(delayMs?: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const seconds = pollIntervalSeconds();
    if (seconds === 0 || this.watchers.size === 0) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollOnce().finally(() => this.schedule());
    }, delayMs ?? seconds * 1_000 * this.backoffFactor);
    this.timer.unref?.();
  }

  /**
   * One polling cycle: lists a bounded number of watched directories and fires Created / Changed /
   * Deleted for what differs from the previous listing. Skipped while the window is in the
   * background; backs off on 429 / errors. Resolves to the number of directories listed.
   */
  async pollOnce(options: { force?: boolean; target?: ServerRef } = {}): Promise<number> {
    if (this.polling) {
      return 0;
    }
    if (!options.force && vscode.window.state && !vscode.window.state.focused) {
      return 0;
    }

    this.polling = true;
    let listed = 0;
    let failed = false;
    try {
      const seconds = options.force ? MIN_POLL_SECONDS : pollIntervalSeconds() || MIN_POLL_SECONDS;
      const budget = Math.max(1, Math.min(MAX_DIRS_PER_CYCLE, Math.floor((POLL_BUDGET_PER_MINUTE * seconds) / 60)));

      const now = Date.now();
      const eligible = (t: PollTarget): boolean =>
        (this.missingUntil.get(this.cacheKey(t, t.path)) ?? 0) <= now &&
        (!options.target || (t.origin === options.target.origin && t.server === options.target.server));

      // Two passes: the second picks up folders whose parent listing (first pass) just proved they are folders.
      const done = new Set<string>();
      let remaining = budget;
      for (let pass = 0; pass < 2 && remaining > 0 && !failed; pass++) {
        let targets = this.pollTargets().filter((t) => eligible(t) && !done.has(this.cacheKey(t, t.path)));
        if (pass === 0 && targets.length > remaining) {
          // Round-robin so every watched directory is eventually visited.
          const start = this.cursor % targets.length;
          targets = [...targets.slice(start), ...targets.slice(0, start)];
          this.cursor = start + remaining;
        }

        for (const target of targets.slice(0, remaining)) {
          done.add(this.cacheKey(target, target.path));
          remaining--;
          const outcome = await this.pollDirectory(target);
          if (outcome === 'listed') {
            listed++;
          } else if (outcome === 'error') {
            failed = true;
            break;
          }
        }
      }
    } finally {
      this.polling = false;
    }

    this.backoffFactor = failed ? Math.min(this.backoffFactor * 2, MAX_BACKOFF_FACTOR) : 1;
    return listed;
  }

  private async pollDirectory(target: PollTarget): Promise<'listed' | 'missing' | 'error' | 'skipped'> {
    const key = this.cacheKey(target, target.path);
    let entries: FileEntry[];
    try {
      // Never prompts for a sign-in: a background poll must not pop dialogs.
      const client = await this.session.clientIfSignedIn(target.origin);
      if (!client) {
        return 'skipped';
      }
      entries = await client.listDirectory(target.server, target.path);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 500 || err.status === 404)) {
        // This Wings answers 500 for a directory that no longer exists; its parent reports the deletion.
        this.snapshots.delete(key);
        this.cache.delete(key);
        this.missingUntil.set(key, Date.now() + MISSING_DIR_PAUSE_MS);
        return 'missing';
      }
      log.warn(`fs poll ${key} failed: ${err}`);
      return 'error'; // includes 429: the whole cycle stops and the next one waits longer
    }

    this.cache.set(key, { at: Date.now(), entries });

    const next = snapshotOf(entries);
    const previous = this.snapshots.get(key);
    this.snapshots.set(key, next);
    if (!previous) {
      return 'listed'; // first sight of a directory is its baseline, not a change
    }

    const events: vscode.FileChangeEvent[] = [];
    const at = (name: string) => serverUri(target.origin, target.server, joinPath(target.path, name));
    for (const [name, state] of next) {
      const before = previous.get(name);
      if (!before) {
        events.push({ type: vscode.FileChangeType.Created, uri: at(name) });
      } else if (state.isFile && (!before.isFile || before.size !== state.size || before.mtime !== state.mtime)) {
        events.push({ type: vscode.FileChangeType.Changed, uri: at(name) });
      }
    }
    for (const name of previous.keys()) {
      if (!next.has(name)) {
        events.push({ type: vscode.FileChangeType.Deleted, uri: at(name) });
      }
    }

    if (events.length > 0) {
      log.debug(`fs poll ${key}: ${events.length} change(s)`);
      this.didChangeEmitter.fire(events);
    }
    return 'listed';
  }

  private cacheKey(ref: ServerRef, directory: string): string {
    return `${ref.origin}\0${ref.server}\0${directory}`;
  }

  private async listCached(ref: ServerRef, directory: string): Promise<FileEntry[]> {
    const key = this.cacheKey(ref, directory);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      this.seedSnapshot(ref, directory, key, hit.entries);
      return hit.entries;
    }

    log.trace(`fs list ${key}`);
    const client = await this.session.client(ref.origin);
    const entries = await client.listDirectory(ref.server, directory);
    this.cache.set(key, { at: Date.now(), entries });
    this.seedSnapshot(ref, directory, key, entries);
    return entries;
  }

  /** Whatever the editor just saw of a watched folder is its baseline: later differences are external changes. */
  private seedSnapshot(ref: ServerRef, directory: string, key: string, entries: FileEntry[]): void {
    if (!this.snapshots.has(key) && this.isWatchRelevant(ref, directory)) {
      this.snapshots.set(key, snapshotOf(entries));
    }
  }

  /** Is this folder the watched path itself or the folder holding it? (path-based: needs no listing to know) */
  private isWatchRelevant(ref: ServerRef, directory: string): boolean {
    const wanted = directory.replace(/\/+$/, '') || '/';
    for (const watcher of this.watchers) {
      const other = refOf(watcher.uri);
      if (other.origin !== ref.origin || other.server !== ref.server) {
        continue;
      }
      const path = watcher.uri.path.replace(/\/+$/, '') || '/';
      if (path === wanted || splitPath(path).parent === wanted) {
        return true;
      }
    }
    return false;
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

  /** Our own writes call this: forgetting the snapshot too keeps the next poll from echoing them back as external changes. */
  private invalidate(ref: ServerRef, directory: string): void {
    const key = this.cacheKey(ref, directory);
    this.cache.delete(key);
    this.snapshots.delete(key);
    this.missingUntil.delete(key);
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
      { location: vscode.ProgressLocation.Window, title: vscode.l10n.t('XeroHost: uploading {0}', name) },
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
      throw vscode.FileSystemError.Unavailable(vscode.l10n.t('Cannot rename across servers.'));
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
      throw vscode.FileSystemError.Unavailable(vscode.l10n.t('Only xerohost:// URIs are supported.'));
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
