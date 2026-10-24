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

type CallbackResult = { key: string } | { error: string } | null;

function randomState(): string {
  return crypto.randomBytes(24).toString('base64url');
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
  const callback = await startCallbackServer();

  try {
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(callback.url));
    const query = [
      `callback_url=${encodeURIComponent(external.toString(true))}`,
      `state=${encodeURIComponent(callback.state)}`,
      `client=${encodeURIComponent(CLIENT_NAME)}`,
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

function startCallbackServer(): Promise<{
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

      const key = requested.searchParams.get('key');
      const error = requested.searchParams.get('error');

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
