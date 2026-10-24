import type { Account, FileEntry, PowerAction, Server, WebsocketCredentials } from './types.ts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiError(response: Response): Promise<ApiError> {
  let message = `${response.status} ${response.statusText}`.trim();
  try {
    const body = (await response.json()) as { errors?: { detail?: unknown }[]; error?: unknown };
    const detail = body.errors?.[0]?.detail;
    if (typeof detail === 'string' && detail) {
      message = detail;
    } else if (typeof body.error === 'string') {
      message = body.error;
    }
  } catch {
    // not json
  }
  return new ApiError(response.status, message);
}

export interface Credentials {
  origin: string;
  apiKey: string;
}

export type ReauthHandler = (client: PanelClient) => Promise<boolean>;

const DEFAULT_TIMEOUT_MS = 60_000;
const ARCHIVE_TIMEOUT_MS = 15 * 60_000;

interface Attributes<T> {
  attributes: T;
}

interface ListResponse<T> {
  data: Attributes<T>[];
  meta?: { pagination?: { current_page: number; total_pages: number } };
}

interface RequestOptions extends RequestInit {
  timeoutMs?: number;
}

export class PanelClient {
  readonly origin: string;
  private apiKey: string;

  constructor(
    credentials: Credentials,
    private readonly reauth?: ReauthHandler,
  ) {
    this.origin = credentials.origin;
    this.apiKey = credentials.apiKey;
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  private async request(path: string, init: RequestOptions = {}, allowReauth = true): Promise<Response> {
    const { timeoutMs, ...rest } = init;
    const response = await fetch(`${this.origin}${path}`, {
      ...rest,
      signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/vnd.pterodactyl.v1+json',
        ...rest.headers,
      },
    });

    if (response.status === 401 && allowReauth && this.reauth && (await this.reauth(this))) {
      return this.request(path, init, false);
    }

    if (!response.ok) {
      throw await apiError(response);
    }

    return response;
  }

  private async json<T>(path: string, init: RequestOptions = {}): Promise<T> {
    const response = await this.request(path, init);
    return (await response.json()) as T;
  }

  private post(path: string, method: string, body: unknown, timeoutMs?: number): Promise<Response> {
    return this.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs,
    });
  }

  async getAccount(): Promise<Account> {
    const { attributes } = await this.json<Attributes<Account>>('/api/client/account');
    return attributes;
  }

  async listServers(): Promise<Server[]> {
    const servers: Server[] = [];
    for (let page = 1; ; page++) {
      const body = await this.json<ListResponse<Server>>(`/api/client?page=${page}&per_page=100`);
      servers.push(...body.data.map((item) => item.attributes));
      const pagination = body.meta?.pagination;
      if (!pagination || page >= pagination.total_pages || body.data.length === 0) {
        return servers;
      }
    }
  }

  async getServer(id: string): Promise<Server> {
    const { attributes } = await this.json<Attributes<Server>>(`/api/client/servers/${encodeURIComponent(id)}`);
    return attributes;
  }

  private files(server: string): string {
    return `/api/client/servers/${encodeURIComponent(server)}/files`;
  }

  async listDirectory(server: string, directory: string): Promise<FileEntry[]> {
    const params = new URLSearchParams({ directory });
    const body = await this.json<ListResponse<FileEntry>>(`${this.files(server)}/list?${params}`);
    return body.data.map((item) => item.attributes);
  }

  async readFile(server: string, file: string): Promise<Uint8Array> {
    const params = new URLSearchParams({ file });
    const response = await this.request(`${this.files(server)}/contents?${params}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  private async signedUrl(path: string): Promise<string> {
    const { attributes } = await this.json<Attributes<{ url: string }>>(path);
    return attributes.url;
  }

  async downloadFile(server: string, file: string): Promise<Uint8Array> {
    const params = new URLSearchParams({ file });
    const url = await this.signedUrl(`${this.files(server)}/download?${params}`);

    const response = await fetch(url, { signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS) });
    if (!response.ok) {
      throw await apiError(response);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async writeFile(server: string, file: string, content: Uint8Array): Promise<void> {
    const params = new URLSearchParams({ file });
    await this.request(`${this.files(server)}/write?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: Buffer.from(content),
    });
  }

  async uploadFile(server: string, directory: string, name: string, content: Uint8Array): Promise<void> {
    const base = await this.signedUrl(`${this.files(server)}/upload`);

    const form = new FormData();
    form.append('files', new Blob([content]), name);

    const response = await fetch(`${base}&directory=${encodeURIComponent(directory)}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw await apiError(response);
    }
  }

  async createDirectory(server: string, root: string, name: string): Promise<void> {
    await this.post(`${this.files(server)}/create-folder`, 'POST', { root, name });
  }

  async rename(server: string, root: string, from: string, to: string): Promise<void> {
    await this.post(`${this.files(server)}/rename`, 'PUT', { root, files: [{ from, to }] });
  }

  async delete(server: string, root: string, files: string[]): Promise<void> {
    await this.post(`${this.files(server)}/delete`, 'POST', { root, files });
  }

  async compress(server: string, root: string, files: string[]): Promise<string> {
    const response = await this.post(`${this.files(server)}/compress`, 'POST', { root, files }, ARCHIVE_TIMEOUT_MS);
    const { attributes } = (await response.json()) as Attributes<FileEntry>;
    return attributes.name;
  }

  async decompress(server: string, root: string, file: string): Promise<void> {
    await this.post(`${this.files(server)}/decompress`, 'POST', { root, file }, ARCHIVE_TIMEOUT_MS);
  }

  async getWebsocketCredentials(server: string): Promise<WebsocketCredentials> {
    const { data } = await this.json<{ data: WebsocketCredentials }>(
      `/api/client/servers/${encodeURIComponent(server)}/websocket`,
    );
    return data;
  }

  async sendPowerAction(server: string, signal: PowerAction): Promise<void> {
    await this.post(`/api/client/servers/${encodeURIComponent(server)}/power`, 'POST', { signal });
  }
}
