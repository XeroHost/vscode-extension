import * as vscode from 'vscode';
import { ApiError, PanelClient } from './api/client.ts';
import { provisionApiKey } from './auth.ts';
import { log } from './log.ts';
import { checkOrigin } from './origin.ts';

const ORIGINS_KEY = 'xerohost.origins';
const API_KEY_PREFIX = 'xerohost.apiKey:';
const REAUTH_COOLDOWN_MS = 5 * 60_000;

export class Session {
  private readonly clients = new Map<string, PanelClient>();
  private readonly signingIn = new Map<string, Promise<PanelClient | null>>();
  private readonly reauthing = new Map<string, Promise<boolean>>();
  private readonly declinedAt = new Map<string, number>();

  private readonly didChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.didChangeEmitter.event;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  async origins(): Promise<string[]> {
    const raw = await this.secrets.get(ORIGINS_KEY);
    if (!raw) {
      return [];
    }
    try {
      const list = JSON.parse(raw) as unknown;
      return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  async client(origin?: string): Promise<PanelClient> {
    const target = await this.resolveOrigin(origin);

    if (target) {
      const existing = await this.tryClient(target);
      if (existing) {
        return existing;
      }
    }

    const client = await this.promptSignIn(target, true);
    if (!client) {
      throw new Error('Not signed in to a XeroHost panel.');
    }
    return client;
  }

  async clientIfSignedIn(origin?: string): Promise<PanelClient | null> {
    const target = await this.resolveOrigin(origin);
    return target ? this.tryClient(target) : null;
  }

  private async resolveOrigin(origin?: string): Promise<string | null> {
    if (origin !== undefined) {
      const checked = checkOrigin(origin);
      if (!checked.ok) {
        throw new Error(`Refusing panel "${origin}": ${checked.reason}.`);
      }
      return checked.origin;
    }
    return (await this.origins())[0] ?? null;
  }

  private async tryClient(origin: string): Promise<PanelClient | null> {
    const cached = this.clients.get(origin);
    if (cached) {
      return cached;
    }

    const apiKey = await this.secrets.get(API_KEY_PREFIX + origin);
    if (!apiKey) {
      return null;
    }

    const client = this.makeClient(origin, apiKey);
    this.clients.set(origin, client);
    return client;
  }

  private makeClient(origin: string, apiKey: string): PanelClient {
    return new PanelClient({ origin, apiKey }, (client) => this.reauth(client));
  }

  async promptSignIn(presetOrigin?: string | null, confirm = false): Promise<PanelClient | null> {
    const origin =
      presetOrigin ??
      (await vscode.window.showInputBox({
        title: 'XeroHost: Panel URL',
        prompt: 'The URL of your XeroHost panel',
        value: 'https://',
        ignoreFocusOut: true,
        validateInput: (value) => {
          const checked = checkOrigin(value);
          return checked.ok ? null : checked.reason;
        },
      }));
    if (!origin) {
      return null;
    }

    return this.provisionSignIn(origin, confirm);
  }

  /** With `confirm`, the user must approve connecting to this panel first (used when the request came from a link or a workspace). */
  provisionSignIn(origin: string, confirm = false): Promise<PanelClient | null> {
    const checked = checkOrigin(origin);
    if (!checked.ok) {
      vscode.window.showErrorMessage(`XeroHost: ${checked.reason}.`);
      return Promise.resolve(null);
    }

    const inFlight = this.signingIn.get(checked.origin);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async () => {
      if (confirm) {
        const SIGN_IN = 'Sign in';
        const choice = await vscode.window.showWarningMessage(
          `XeroHost wants to sign in to ${checked.origin}. Only continue if you trust this panel.`,
          { modal: true },
          SIGN_IN,
        );
        if (choice !== SIGN_IN) {
          return null;
        }
      }

      const key = await provisionApiKey(checked.origin);
      if (!key) {
        log.info(`session: sign-in for ${checked.origin} was cancelled or timed out`);
        return null;
      }
      return this.signInWithKey(checked.origin, key);
    })();
    this.signingIn.set(checked.origin, promise);
    void promise.finally(() => this.signingIn.delete(checked.origin));
    return promise;
  }

  async signInWithKey(origin: string, apiKey: string): Promise<PanelClient | null> {
    const checked = checkOrigin(origin);
    if (!checked.ok) {
      return null;
    }

    const candidate = new PanelClient({ origin: checked.origin, apiKey });
    const account = await this.verify(candidate);
    if (!account) {
      return null;
    }

    await this.remember(checked.origin, apiKey);
    const client = this.makeClient(checked.origin, apiKey);
    this.clients.set(client.origin, client);
    this.declinedAt.delete(client.origin);
    this.didChangeEmitter.fire();

    vscode.window.showInformationMessage(`XeroHost: signed in as ${account.username} (${client.origin}).`);
    return client;
  }

  private async verify(client: PanelClient) {
    try {
      return await client.getAccount();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        vscode.window.showErrorMessage('XeroHost: the panel rejected the API key.');
      } else {
        vscode.window.showErrorMessage(`XeroHost: could not reach the panel (${err}).`);
      }
      return null;
    }
  }

  private reauth(client: PanelClient): Promise<boolean> {
    const origin = client.origin;
    const inFlight = this.reauthing.get(origin);
    if (inFlight) {
      return inFlight;
    }

    const declined = this.declinedAt.get(origin);
    if (declined !== undefined && Date.now() - declined < REAUTH_COOLDOWN_MS) {
      return Promise.resolve(false);
    }

    const promise = this.promptReauth(client);
    this.reauthing.set(origin, promise);
    void promise.finally(() => this.reauthing.delete(origin));
    return promise;
  }

  private async promptReauth(client: PanelClient): Promise<boolean> {
    const origin = client.origin;
    log.warn(`re-authentication required for ${origin}`);

    const SIGN_IN = 'Sign in again';
    const choice = await vscode.window.showWarningMessage(
      `XeroHost: ${origin} rejected your API key (it may have been revoked or expired).`,
      SIGN_IN,
    );
    if (choice !== SIGN_IN) {
      this.declinedAt.set(origin, Date.now());
      return false;
    }

    const renewed = await this.provisionSignIn(origin);
    if (!renewed) {
      this.declinedAt.set(origin, Date.now());
      return false;
    }

    const apiKey = await this.secrets.get(API_KEY_PREFIX + origin);
    if (!apiKey) {
      return false;
    }
    client.setApiKey(apiKey);
    return true;
  }

  async signOut(origin?: string): Promise<void> {
    const origins = await this.origins();
    const targets = origin ? [new URL(origin).origin] : origins;

    for (const target of targets) {
      await this.secrets.delete(API_KEY_PREFIX + target);
      this.clients.delete(target);
    }

    const remaining = origins.filter((o) => !targets.includes(o));
    if (remaining.length > 0) {
      await this.secrets.store(ORIGINS_KEY, JSON.stringify(remaining));
    } else {
      await this.secrets.delete(ORIGINS_KEY);
    }

    this.didChangeEmitter.fire();
  }

  private async remember(origin: string, apiKey: string): Promise<void> {
    await this.secrets.store(API_KEY_PREFIX + origin, apiKey);
    const origins = (await this.origins()).filter((o) => o !== origin);
    origins.unshift(origin);
    await this.secrets.store(ORIGINS_KEY, JSON.stringify(origins));
  }
}
