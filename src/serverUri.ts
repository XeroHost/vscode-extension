import * as vscode from 'vscode';

export const SCHEME = 'xerohost';

export interface ServerRef {
  origin: string;
  server: string;
}

// xerohost://<hex(origin)>.<server-uuid>/<path...>
export function serverUri(origin: string, server: string, path = '/'): vscode.Uri {
  const authority = `${Buffer.from(new URL(origin).origin, 'utf8').toString('hex')}.${server.toLowerCase()}`;
  return vscode.Uri.from({ scheme: SCHEME, authority, path });
}

export function decodeAuthority(authority: string): ServerRef {
  const dot = authority.indexOf('.');
  if (dot < 0) {
    return { origin: '', server: authority };
  }
  let origin = '';
  try {
    origin = Buffer.from(authority.slice(0, dot), 'hex').toString('utf8');
  } catch {
    origin = '';
  }
  return { origin, server: authority.slice(dot + 1) };
}

export function refOf(uri: vscode.Uri): ServerRef {
  return decodeAuthority(uri.authority);
}
