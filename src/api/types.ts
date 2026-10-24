export interface Pagination {
  total: number;
  count: number;
  per_page: number;
  current_page: number;
  total_pages: number;
}

export interface Server {
  identifier: string;
  uuid: string;
  name: string;
  description: string | null;
  status: string | null;
  is_suspended: boolean;
  is_installing: boolean;
  node: string;
}

export interface FileEntry {
  name: string;
  mode: string;
  mode_bits: string;
  size: number;
  is_file: boolean;
  is_symlink: boolean;
  mimetype: string;
  created_at: string;
  modified_at: string;
}

export interface WebsocketCredentials {
  token: string;
  socket: string;
}

export interface Account {
  id: number;
  username: string;
  email: string;
}

export type PowerAction = 'start' | 'stop' | 'restart' | 'kill';

export type PowerState = 'offline' | 'starting' | 'running' | 'stopping';

export interface ResourceUsage {
  memory_bytes: number;
  memory_limit_bytes: number;
  disk_bytes: number;
  state: PowerState;
  network: { rx_bytes: number; tx_bytes: number };
  cpu_absolute: number;
  uptime: number;
}
