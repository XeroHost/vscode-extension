import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as vscode from 'vscode';
import { callbackPage, pickLanguage } from './authPage.ts';
import { log } from './log.ts';

const AUTHORIZE_PATH = '/account/vscode/authorize';
const CALLBACK_PATH = '/callback';
const CLIENT_NAME = 'VS Code';
const CALLBACK_TIMEOUT_MS = 5 * 60_000;
const TOKEN_PATH = '/integrations/vscode/token';
const TOKEN_TIMEOUT_MS = 15_000;

type CallbackResult = { key: string } | { error: string } | null;

function randomState(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/** PKCE pair: the challenge goes to the browser, the verifier never leaves this process. */
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

/**
 * Trades the one-time code from the callback for the API key. The panel only
 * sends a code (never the key) through the browser when it got a challenge, so
 * the key does not end up in the browser history.
 */
async function exchangeCode(origin: string, code: string, verifier: string): Promise<string | null> {
  try {
    const response = await fetch(`${origin}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    if (!response.ok) {
      log.warn(`auth: code exchange refused (${response.status})`);
      return null;
    }
    const body = (await response.json()) as { key?: unknown };
    return typeof body.key === 'string' && body.key ? body.key : null;
  } catch (err) {
    log.warn(`auth: code exchange failed: ${err}`);
    return null;
  }
}

function statesMatch(expected: string, received: string | null): boolean {
  if (received === null) {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Signs in through the panel: opens the authorize page in the browser with a loopback callback
 * and waits for the panel to hand the key back, or for the user to paste one manually.
 */
export async function provisionApiKey(origin: string): Promise<string | null> {
  const pkce = pkcePair();
  const callback = await startCallbackServer((code) => exchangeCode(origin, code, pkce.verifier));

  try {
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(callback.url));
    const query = [
      `callback_url=${encodeURIComponent(external.toString(true))}`,
      `state=${encodeURIComponent(callback.state)}`,
      `client=${encodeURIComponent(CLIENT_NAME)}`,
      `code_challenge=${encodeURIComponent(pkce.challenge)}`,
    ].join('&');
    const target = `${origin}${AUTHORIZE_PATH}?${query}`;

    log.info(`auth: opening ${origin}${AUTHORIZE_PATH}`);
    await vscode.env.openExternal(vscode.Uri.parse(target));

    return await awaitKey(origin, callback.result);
  } finally {
    callback.dispose();
  }
}

async function awaitKey(origin: string, fromCallback: Promise<CallbackResult>): Promise<string | null> {
  const tokenSource = new vscode.CancellationTokenSource();
  void fromCallback.then(() => tokenSource.cancel());

  const manual = vscode.window.withProgress<string | undefined>(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('XeroHost: waiting for authorization from {0}...', origin),
      cancellable: true,
    },
    (_progress, progressToken) => {
      progressToken.onCancellationRequested(() => tokenSource.cancel());
      return Promise.resolve(
        vscode.window.showInputBox(
          {
            title: vscode.l10n.t('XeroHost: finish signing in'),
            prompt: vscode.l10n.t('Approve in your browser to finish automatically, or paste an API key here.'),
            password: true,
            ignoreFocusOut: true,
          },
          tokenSource.token,
        ),
      );
    },
  );

  const outcome = await Promise.race([fromCallback, manual.then((value) => (value ? { key: value } : null))]);
  tokenSource.dispose();

  if (outcome && 'error' in outcome) {
    vscode.window.showWarningMessage(
      outcome.error === 'access_denied'
        ? vscode.l10n.t('XeroHost: the authorization was cancelled in the panel.')
        : vscode.l10n.t('XeroHost: the panel refused the sign-in ({0}).', outcome.error),
    );
    return null;
  }

  const key = outcome?.key.trim();
  return key ? key : null;
}

function startCallbackServer(exchange: (code: string) => Promise<string | null>): Promise<{
  url: string;
  state: string;
  result: Promise<CallbackResult>;
  dispose: () => void;
}> {
  return new Promise((resolve, reject) => {
    let deliver!: (value: CallbackResult) => void;
    const result = new Promise<CallbackResult>((res) => {
      deliver = res;
    });

    const state = randomState();
    let settled = false;

    const respond = (
      req: http.IncomingMessage,
      res: http.ServerResponse,
      status: number,
      page: Omit<Parameters<typeof callbackPage>[0], 'language'>,
    ) => {
      const body = callbackPage({ ...page, language: pickLanguage(req.headers['accept-language']) });
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(body);
    };

    const server = http.createServer((req, res) => {
      const requested = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (settled || req.method !== 'GET' || requested.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      if (!statesMatch(state, requested.searchParams.get('state'))) {
        respond(req, res, 400, { tone: 'error', heading: 'invalidHeading', message: 'invalidMessage' });
        return;
      }

      const code = requested.searchParams.get('code');
      const key = requested.searchParams.get('key');
      const error = requested.searchParams.get('error');

      if (code) {
        settled = true;
        void exchange(code).then((exchanged) => {
          if (exchanged) {
            respond(req, res, 200, { tone: 'success', heading: 'signedInHeading', message: 'signedInMessage' });
            deliver({ key: exchanged });
          } else {
            respond(req, res, 400, { tone: 'error', heading: 'invalidHeading', message: 'invalidMessage' });
            deliver({ error: 'invalid_code' });
          }
        });
        return;
      }

      // Panels older than the one-time code flow still send the key itself.
      if (key) {
        settled = true;
        respond(req, res, 200, { tone: 'success', heading: 'signedInHeading', message: 'signedInMessage' });
        deliver({ key });
        return;
      }

      settled = true;
      respond(req, res, 200, { tone: 'error', heading: 'cancelledHeading', message: 'cancelledMessage' });
      deliver({ error: error ?? 'no_key' });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const timeout = setTimeout(() => deliver(null), CALLBACK_TIMEOUT_MS);
      resolve({
        url: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
        state,
        result,
        dispose: () => {
          clearTimeout(timeout);
          deliver(null);
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}
