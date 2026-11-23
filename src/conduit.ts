import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ConduitConfig {
  /** Base URL with trailing slash, e.g. https://phab.example.com/ */
  host: string;
  token: string;
}

interface ConduitEnvelope<T> {
  result: T;
  error_code: string | null;
  error_info: string | null;
}

export class ConduitError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export class Conduit {
  constructor(private readonly config: ConduitConfig) {}

  get host(): string {
    return this.config.host;
  }

  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const body = new URLSearchParams({
      params: JSON.stringify({ ...params, __conduit__: { token: this.config.token } }),
      output: 'json',
      __conduit__: '1',
    });
    const res = await fetch(`${this.config.host}api/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new ConduitError('HTTP', `${method}: HTTP ${res.status} ${res.statusText}`);
    }
    const envelope = (await res.json()) as ConduitEnvelope<T>;
    if (envelope.error_code) {
      throw new ConduitError(envelope.error_code, envelope.error_info ?? envelope.error_code);
    }
    return envelope.result;
  }
}

function normalizeHost(uri: string): string {
  return uri.endsWith('/') ? uri : `${uri}/`;
}

/** Walks up from `dir` looking for .arcconfig and returns its phabricator.uri. */
export function hostFromArcconfig(dir: string): string | undefined {
  let current = dir;
  for (;;) {
    const candidate = path.join(current, '.arcconfig');
    if (fs.existsSync(candidate)) {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { 'phabricator.uri'?: string; 'conduit_uri'?: string };
      const uri = parsed['phabricator.uri'] ?? parsed['conduit_uri'];
      return uri ? normalizeHost(uri) : undefined;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/** Reads the API token for `host` from ~/.arcrc. */
export function tokenFromArcrc(host: string): string | undefined {
  const arcrcPath = path.join(os.homedir(), '.arcrc');
  if (!fs.existsSync(arcrcPath)) {
    return undefined;
  }
  const arcrc = JSON.parse(fs.readFileSync(arcrcPath, 'utf8')) as { hosts?: Record<string, { token?: string }> };
  const hosts = arcrc.hosts ?? {};
  const key = Object.keys(hosts).find((k) => normalizeHost(k) === `${host}api/` || normalizeHost(k) === host);
  return key ? hosts[key].token : undefined;
}

export function resolveConduitConfig(repoRoot: string, hostOverride: string): ConduitConfig {
  const host = hostOverride ? normalizeHost(hostOverride) : hostFromArcconfig(repoRoot);
  if (!host) {
    throw new Error('No Phabricator host: set phabreview.host or add phabricator.uri to .arcconfig');
  }
  const token = tokenFromArcrc(host);
  if (!token) {
    throw new Error(`No API token for ${host} in ~/.arcrc (run "arc install-certificate")`);
  }
  return { host, token };
}
