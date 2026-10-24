import * as vscode from 'vscode';
import type { PowerState } from '../api/types.ts';
import { stateLabel } from '../format.ts';
import { log } from '../log.ts';
import type { MountedServer } from '../servers.ts';
import type { WingsSocketHub, WingsSocketLease } from '../wings/socketHub.ts';

const DAEMON_PROMPT = 'container@pterodactyl~';
const RED_BOLD = '\x1b[1m\x1b[41m';

function configuredPrompt(): string {
  return vscode.workspace.getConfiguration('xerohost').get<string>('console.prompt', 'container@xerohost~');
}

export class ConsolePseudoterminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;

  private socket: WingsSocketLease | null = null;
  private input = '';
  private history: string[] = [];
  private historyIndex = -1;

  constructor(
    private readonly hub: WingsSocketHub,
    readonly target: MountedServer,
  ) {}

  open(): void {
    this.addLine(vscode.l10n.t('Connecting to {0}...', this.target.name), true);

    const socket = this.hub.acquire(this.target.origin, this.target.uuid);
    this.socket = socket;

    socket.whenAuthenticated(() => {
      socket.send('send logs', [null]);
      socket.send('send status');
    });

    socket.on('console output', (line: string) => this.addLine(line));
    socket.on('install output', (line: string) => this.addLine(line));
    socket.on('transfer logs', (line: string) => this.addLine(line));

    socket.on('status', (status: PowerState) => {
      this.addLine(vscode.l10n.t('Server marked as {0}...', stateLabel(status)), true);
    });

    socket.on('install started', () => this.addLine(vscode.l10n.t('Installation has started.'), true));
    socket.on('install completed', () => this.addLine(vscode.l10n.t('Installation has completed.'), true));

    socket.on('daemon message', (message: string) => this.addLine(message, true));
    socket.on('daemon error', (message: string) => this.addLine(`${RED_BOLD}${message}\x1b[0m`, true));

    socket.on('CONNECTION_STATE', (state: string) => {
      if (state === 'reconnecting') {
        this.addLine(vscode.l10n.t('Connection lost, reconnecting...'), true);
      }
    });
    socket.on('CONNECTION_ERROR', (err: Error) => {
      log.error(`console [${this.target.name}]: ${err.message}`);
      this.addLine(`${RED_BOLD}${err.message}\x1b[0m`, true);
    });
  }

  close(): void {
    this.socket?.release();
    this.socket = null;
  }

  private addLine(text: string, prelude = false): void {
    const prompt = configuredPrompt();
    let processed = text.replaceAll('\x1b[?25h', '').replaceAll('\x1b[?25l', '');

    if (processed.includes(DAEMON_PROMPT)) {
      processed = processed.replace(DAEMON_PROMPT, prompt);
    }

    if (prelude && !processed.includes(RED_BOLD)) {
      processed = `\x1b[1m\x1b[33m${prompt} \x1b[0m${processed}`;
    }

    this.println(processed);
  }

  handleInput(data: string): void {
    switch (data) {
      case '\r': {
        this.writeEmitter.fire('\r\x1b[K');
        const command = this.input;
        this.input = '';
        this.historyIndex = -1;
        if (command.trim().length > 0) {
          this.history.push(command);
          this.socket?.sendCommand(command);
        }
        return;
      }
      case '\x7f': // backspace
        if (this.input.length > 0) {
          this.input = this.input.slice(0, -1);
          this.writeEmitter.fire('\b \b');
        }
        return;
      case '\x03': // ctrl+c
        this.input = '';
        this.historyIndex = -1;
        this.writeEmitter.fire('^C\r\n');
        return;
      case '\x1b[A': // up
        this.recallHistory(-1);
        return;
      case '\x1b[B': // down
        this.recallHistory(1);
        return;
    }

    if (data.startsWith('\x1b')) {
      return;
    }

    const printable = data.replace(/[\r\n]+/g, ' ');
    this.input += printable;
    this.writeEmitter.fire(printable);
  }

  private recallHistory(direction: -1 | 1): void {
    if (this.history.length === 0) {
      return;
    }

    if (this.historyIndex === -1) {
      if (direction === 1) {
        return;
      }
      this.historyIndex = this.history.length;
    }

    const next = this.historyIndex + direction;
    if (next < 0 || next > this.history.length) {
      return;
    }

    this.writeEmitter.fire('\r\x1b[K');
    this.historyIndex = next;
    this.input = next === this.history.length ? '' : this.history[next];
    this.writeEmitter.fire(this.input);
  }

  private println(line: string): void {
    this.writeEmitter.fire(`\r\x1b[K${line}\r\n`);
    if (this.input.length > 0) {
      this.writeEmitter.fire(this.input);
    }
  }
}

const consoles = new Map<string, vscode.Terminal>();

function consoleKey(server: MountedServer): string {
  return `${server.origin}|${server.uuid.toLowerCase()}`;
}

/** Opens the console of a server, reusing its terminal when one is already open. */
export function openConsoleTerminal(hub: WingsSocketHub, server: MountedServer): vscode.Terminal {
  const key = consoleKey(server);
  const existing = consoles.get(key);
  if (existing && existing.exitStatus === undefined) {
    existing.show();
    return existing;
  }

  const terminal = vscode.window.createTerminal({
    name: vscode.l10n.t('Console: {0}', server.name),
    pty: new ConsolePseudoterminal(hub, server),
    iconPath: new vscode.ThemeIcon('server-environment'),
  });
  consoles.set(key, terminal);
  terminal.show();
  return terminal;
}

export function trackConsoleTerminals(): vscode.Disposable {
  return vscode.window.onDidCloseTerminal((closed) => {
    for (const [key, terminal] of consoles) {
      if (terminal === closed) {
        consoles.delete(key);
      }
    }
  });
}
