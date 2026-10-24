// Minimal stand-in for the `vscode` module so the extension's own classes can run under plain Node.
export class EventEmitter {
  #listeners = new Set();
  event = (listener) => {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  };
  fire(value) {
    for (const listener of [...this.#listeners]) listener(value);
  }
  dispose() {
    this.#listeners.clear();
  }
}

export class Disposable {
  constructor(fn) {
    this.fn = fn;
  }
  dispose() {
    this.fn?.();
  }
}

export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
export const FileChangeType = { Changed: 1, Created: 2, Deleted: 3 };
export class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}

export const ProgressLocation = { Notification: 15, Window: 10 };

export class FileSystemError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
  static FileNotFound = (m) => new FileSystemError(String(m?.path ?? m), 'FileNotFound');
  static FileExists = (m) => new FileSystemError(String(m?.path ?? m), 'FileExists');
  static FileIsADirectory = (m) => new FileSystemError(String(m?.path ?? m), 'FileIsADirectory');
  static NoPermissions = (m) => new FileSystemError(String(m?.path ?? m), 'NoPermissions');
  static Unavailable = (m) => new FileSystemError(String(m?.path ?? m), 'Unavailable');
}

export class CancellationError extends Error {}

export class Uri {
  constructor(scheme, authority, path) {
    Object.assign(this, { scheme, authority, path });
  }
  static from({ scheme, authority = '', path = '' }) {
    return new Uri(scheme, authority, path);
  }
  static parse(value) {
    const uri = new Uri('', '', '');
    uri.raw = value;
    uri.toString = () => value;
    return uri;
  }
  toString() {
    return `${this.scheme}://${this.authority}${this.path}`;
  }
}

const channel = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, dispose() {} };

export class CancellationTokenSource {
  #listeners = [];
  token = { onCancellationRequested: (listener) => this.#listeners.push(listener) };
  cancel() {
    for (const listener of this.#listeners) listener();
  }
  dispose() {}
}

/** Lets a test play the user: `shim.nextInput` is what the next input box returns (or it waits for cancellation). */
export const shim = (globalThis.__xerohostShim ??= { opened: [], nextInput: undefined });

export const env = {
  language: 'en',
  asExternalUri: async (uri) => uri,
  openExternal: async (uri) => {
    shim.opened.push(uri.toString());
    return true;
  },
};

export const window = {
  createOutputChannel: () => channel,
  withProgress: (_options, task) => task({ report() {} }, { onCancellationRequested() {} }),
  showInputBox: (_options, token) =>
    new Promise((resolve) => {
      if (shim.nextInput !== undefined) {
        resolve(shim.nextInput);
      } else {
        token?.onCancellationRequested(() => resolve(undefined));
      }
    }),
  showErrorMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showInformationMessage: async () => undefined,
};

export const workspace = {
  getConfiguration: () => ({ get: (_key, fallback) => fallback }),
};
