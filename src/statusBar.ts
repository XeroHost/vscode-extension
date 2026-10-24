import * as vscode from 'vscode';
import type { PowerAction, PowerState, ResourceUsage } from './api/types.ts';
import { formatBytes, stateLabel } from './format.ts';
import { log } from './log.ts';
import { decodeAuthority, SCHEME } from './serverUri.ts';
import { shortId } from './servers.ts';
import type { Session } from './session.ts';
import type { WingsSocketHub, WingsSocketLease } from './wings/socketHub.ts';

interface ServerEntry {
  origin: string;
  uuid: string;
  name: string;
  lease: WingsSocketLease | null;
  state: PowerState | null;
  stats: ResourceUsage | null;
}

interface PowerButton extends vscode.QuickInputButton {
  action: PowerAction;
}

interface ServerPick extends vscode.QuickPickItem {
  origin: string;
  uuid: string;
  name: string;
}

function entryKey(origin: string, uuid: string): string {
  return `${origin}|${uuid.toLowerCase()}`;
}

function powerLabel(action: PowerAction): string {
  switch (action) {
    case 'start':
      return vscode.l10n.t('Start');
    case 'restart':
      return vscode.l10n.t('Restart');
    case 'stop':
      return vscode.l10n.t('Stop');
    case 'kill':
      return vscode.l10n.t('Kill');
  }
}

const POWER_ACTIONS: { action: PowerAction; icon: string }[] = [
  { action: 'start', icon: 'play' },
  { action: 'restart', icon: 'debug-restart' },
  { action: 'stop', icon: 'debug-stop' },
  { action: 'kill', icon: 'close' },
];

function powerButtons(): PowerButton[] {
  return POWER_ACTIONS.map(({ action, icon }) => ({
    action,
    iconPath: new vscode.ThemeIcon(icon),
    tooltip: powerLabel(action),
  }));
}

function stateIcon(state: PowerState | null): string {
  switch (state) {
    case 'running':
      return '$(vm-running)';
    case 'offline':
      return '$(vm-outline)';
    case null:
      return '$(server-environment)';
    default:
      return '$(sync~spin)';
  }
}

function formatUptime(ms: number): string {
  if (ms <= 0) return '-';
  let seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (!days && !hours) parts.push(`${seconds}s`);
  return parts.join(' ');
}

export class ServerStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly servers = new Map<string, ServerEntry>();
  private readonly disposables: vscode.Disposable[] = [];
  private pinned: string | null = null;

  constructor(
    private readonly session: Session,
    private readonly hub: WingsSocketHub,
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.item.command = 'xerohost.statusBar.switch';

    this.disposables.push(
      vscode.commands.registerCommand('xerohost.statusBar.switch', () => this.showSwitcher()),
      vscode.window.onDidChangeActiveTextEditor(() => this.render()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.syncServers()),
      this.session.onDidChange(() => this.syncServers()),
    );

    this.syncServers();
  }

  pin(origin: string, uuid: string, name: string): void {
    if (!uuid) {
      return;
    }
    const key = entryKey(origin, uuid);
    this.pinned = key;
    const existing = this.servers.get(key);
    if (existing) {
      existing.name = name || existing.name;
    } else {
      this.servers.set(key, { origin, uuid, name, lease: null, state: null, stats: null });
    }
    this.syncServers();
  }

  private syncServers(): void {
    const wanted = new Map<string, { origin: string; uuid: string }>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme === SCHEME) {
        const { origin, server } = decodeAuthority(folder.uri.authority);
        wanted.set(entryKey(origin, server), { origin, uuid: server });
      }
    }

    for (const [key, entry] of this.servers) {
      if (!wanted.has(key) && key !== this.pinned) {
        entry.lease?.release();
        this.servers.delete(key);
      }
    }

    for (const [key, server] of wanted) {
      if (!this.servers.has(key)) {
        this.servers.set(key, { ...server, name: '', lease: null, state: null, stats: null });
      }
    }

    for (const entry of this.servers.values()) {
      void this.connect(entry);
    }

    this.render();
  }

  /** The socket is only opened for panels the user is signed in to, so a status bar never triggers a sign-in prompt. */
  private async connect(entry: ServerEntry): Promise<void> {
    if (entry.lease || !(await this.session.clientIfSignedIn(entry.origin).catch(() => null))) {
      return;
    }
    if (entry.lease || !this.servers.has(entryKey(entry.origin, entry.uuid))) {
      return;
    }

    const key = entryKey(entry.origin, entry.uuid);
    const lease = this.hub.acquire(entry.origin, entry.uuid);
    entry.lease = lease;

    lease.whenAuthenticated(() => {
      lease.send('send stats');
      lease.send('send status');
    });
    lease.on('status', (state: PowerState) => {
      entry.state = state;
      this.renderIfFocused(key);
    });
    lease.on('stats', (raw: string) => {
      try {
        const stats = JSON.parse(raw) as ResourceUsage;
        entry.stats = stats;
        entry.state = stats.state;
        this.renderIfFocused(key);
      } catch {
        // ignore malformed stats frames
      }
    });
    lease.on('CONNECTION_ERROR', (err: Error) => log.debug(`statusbar ws [${entry.uuid}]: ${err.message}`));

    void this.resolveName(entry);
  }

  private async resolveName(entry: ServerEntry): Promise<void> {
    try {
      const client = await this.session.clientIfSignedIn(entry.origin);
      if (!client) {
        return;
      }
      const { name } = await client.getServer(entry.uuid);
      if (name && name !== entry.name) {
        entry.name = name;
        this.render();
      }
    } catch (err) {
      log.debug(`statusbar: could not resolve name for ${entry.uuid}: ${err}`);
    }
  }

  private displayName(entry: ServerEntry): string {
    return entry.name || shortId(entry.uuid);
  }

  private focusedKey(): string | null {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === SCHEME) {
      const { origin, server } = decodeAuthority(uri.authority);
      const key = entryKey(origin, server);
      if (this.servers.has(key)) {
        return key;
      }
    }
    if (this.pinned && this.servers.has(this.pinned)) {
      return this.pinned;
    }
    const first = this.servers.keys().next();
    return first.done ? null : first.value;
  }

  private renderIfFocused(key: string): void {
    if (this.focusedKey() === key) {
      this.render();
    }
  }

  private render(): void {
    const key = this.focusedKey();
    const entry = key ? this.servers.get(key) : undefined;
    if (!entry) {
      this.item.hide();
      return;
    }

    this.item.text = `${stateIcon(entry.state)} ${this.displayName(entry)}${entry.state ? ` (${stateLabel(entry.state)})` : ''}`;
    this.item.tooltip = this.tooltip(entry);
    this.item.show();
  }

  private tooltip(entry: ServerEntry): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${this.displayName(entry)}** - ${entry.state ? stateLabel(entry.state) : vscode.l10n.t('unknown')}\n\n`);

    const stats = entry.stats;
    if (stats) {
      const memLimit = stats.memory_limit_bytes > 0 ? ` / ${formatBytes(stats.memory_limit_bytes)}` : '';
      md.appendMarkdown('|  |  |\n|---|---|\n');
      md.appendMarkdown(`| $(dashboard) ${vscode.l10n.t('CPU')} | ${stats.cpu_absolute.toFixed(1)}% |\n`);
      md.appendMarkdown(`| $(server) ${vscode.l10n.t('Memory')} | ${formatBytes(stats.memory_bytes)}${memLimit} |\n`);
      md.appendMarkdown(`| $(database) ${vscode.l10n.t('Disk')} | ${formatBytes(stats.disk_bytes)} |\n`);
      md.appendMarkdown(
        `| $(arrow-down)$(arrow-up) ${vscode.l10n.t('Network')} | ${formatBytes(stats.network.rx_bytes)} / ${formatBytes(stats.network.tx_bytes)} |\n`,
      );
      md.appendMarkdown(`| $(watch) ${vscode.l10n.t('Uptime')} | ${formatUptime(stats.uptime)} |\n`);
    } else {
      md.appendMarkdown(`_${vscode.l10n.t('Waiting for live stats...')}_\n`);
    }

    md.appendMarkdown(`\n$(list-selection) ${vscode.l10n.t('Click to switch servers or run power actions.')}`);
    return md;
  }

  private statsLine(entry: ServerEntry): string {
    const stats = entry.stats;
    if (!stats) {
      return vscode.l10n.t('no live stats yet');
    }
    return [
      `${vscode.l10n.t('CPU')} ${stats.cpu_absolute.toFixed(1)}%`,
      `${vscode.l10n.t('Memory')} ${formatBytes(stats.memory_bytes)}`,
      `${vscode.l10n.t('Disk')} ${formatBytes(stats.disk_bytes)}`,
      `${vscode.l10n.t('Uptime')} ${formatUptime(stats.uptime)}`,
    ].join('  |  ');
  }

  private showSwitcher(): void {
    if (this.servers.size === 0) {
      vscode.window.showInformationMessage(vscode.l10n.t('XeroHost: no active server.'));
      return;
    }

    const focused = this.focusedKey();
    const qp = vscode.window.createQuickPick<ServerPick>();
    qp.title = vscode.l10n.t('XeroHost servers');
    qp.placeholder = vscode.l10n.t('Select a server to focus - use the buttons for power actions');
    qp.items = [...this.servers.values()].map((entry) => ({
      label: `${stateIcon(entry.state)} ${this.displayName(entry)}`,
      description: entry.state ? stateLabel(entry.state) : vscode.l10n.t('unknown'),
      detail: this.statsLine(entry),
      buttons: powerButtons(),
      origin: entry.origin,
      uuid: entry.uuid,
      name: this.displayName(entry),
    }));
    qp.activeItems = qp.items.filter((i) => entryKey(i.origin, i.uuid) === focused);

    qp.onDidTriggerItemButton((event) => {
      void this.powerAction(event.item.origin, event.item.uuid, event.item.name, (event.button as PowerButton).action);
    });
    qp.onDidAccept(() => {
      const pick = qp.selectedItems[0];
      if (pick) {
        this.pin(pick.origin, pick.uuid, pick.name);
      }
      qp.hide();
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  async showPowerActions(): Promise<void> {
    const key = this.focusedKey();
    const entry = key ? this.servers.get(key) : null;
    if (!entry) {
      vscode.window.showInformationMessage(vscode.l10n.t('XeroHost: no active server.'));
      return;
    }

    const picked = await vscode.window.showQuickPick(
      POWER_ACTIONS.map(({ action, icon }) => ({ label: `$(${icon}) ${powerLabel(action)}`, action })),
      { title: vscode.l10n.t('Power action for {0}', this.displayName(entry)) },
    );
    if (picked) {
      await this.powerAction(entry.origin, entry.uuid, this.displayName(entry), picked.action);
    }
  }

  private async powerAction(origin: string, uuid: string, name: string, action: PowerAction): Promise<void> {
    if (action === 'stop' || action === 'kill') {
      const verb = powerLabel(action);
      const detail =
        action === 'kill' ? vscode.l10n.t('The process is terminated at once and data may be lost.') : undefined;
      const question =
        action === 'kill' ? vscode.l10n.t('Kill {0}?', name) : vscode.l10n.t('Stop {0}?', name);
      const confirmed = await vscode.window.showWarningMessage(question, { modal: true, detail }, verb);
      if (confirmed !== verb) {
        return;
      }
    }

    try {
      const client = await this.session.client(origin);
      await client.sendPowerAction(uuid, action);
      vscode.window.setStatusBarMessage(vscode.l10n.t('XeroHost: "{0}" sent to {1}', powerLabel(action), name), 4000);
    } catch (err) {
      vscode.window.showErrorMessage(vscode.l10n.t('XeroHost: power action failed ({0}).', String(err)));
    }
  }

  dispose(): void {
    for (const entry of this.servers.values()) {
      entry.lease?.release();
    }
    this.servers.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.item.dispose();
  }
}
