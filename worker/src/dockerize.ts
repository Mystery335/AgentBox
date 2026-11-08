// Turns the legacy-system zip into a runnable Docker image.
//
//   zip  ->  .cache/legacy/<sha12>/  (safe extract)
//        ->  find the Dockerfile
//        ->  docker build -t agentproof-legacy:<sha12>
//
// The zip must contain a Dockerfile (the legacy system is "delivered as a
// Dockerfile", shared context v3 §2). Same zip -> same folder and image tag,
// so re-running is cheap and results are traceable to the exact input.

import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker, type ExecResult } from './docker.ts';
import { extractZip, type UnzipLimits, DEFAULT_LIMITS } from './unzip.ts';

export const AGENTBOX_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE_DIR = path.join(AGENTBOX_ROOT, '.cache', 'legacy');
const DOCKERFILE_NAMES = new Set(['dockerfile', 'containerfile']);

export interface LegacyBundle {
  zipPath: string;
  zipSha256: string;
  extractDir: string;
  /** Build context: the folder that holds the Dockerfile. */
  contextDir: string;
  /** Dockerfile path relative to extractDir. */
  dockerfile: string;
  files: string[];
  imageTag: string;
  buildLog: string;
}

export class DockerizeError extends Error {
  constructor(message: string, readonly log = '') {
    super(message);
  }
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Picks the Dockerfile: the shallowest one; error if there are several at that depth. */
export function findDockerfile(files: string[]): string {
  const candidates = files.filter(f => DOCKERFILE_NAMES.has(path.posix.basename(f).toLowerCase()));
  if (candidates.length === 0) {
    throw new DockerizeError('the zip has no Dockerfile; the legacy system must include one');
  }
  const depth = (f: string) => f.split('/').length;
  const minDepth = Math.min(...candidates.map(depth));
  const shallowest = candidates.filter(f => depth(f) === minDepth);
  if (shallowest.length > 1) {
    throw new DockerizeError(`several Dockerfiles at the same level: ${shallowest.join(', ')}`);
  }
  return shallowest[0];
}

export async function buildImage(contextDir: string, dockerfile: string, tag: string, timeoutMs = 15 * 60_000): Promise<ExecResult> {
  // Build may use the network (apt-get etc.); every RUN of the image is offline.
  return docker(['build', '--progress', 'plain', '-t', tag, '-f', dockerfile, contextDir], { timeoutMs });
}

export async function dockerizeZip(
  zipPath: string,
  opts: { limits?: UnzipLimits; rebuild?: boolean; buildTimeoutMs?: number } = {}
): Promise<LegacyBundle> {
  const abs = path.resolve(zipPath);
  if (!existsSync(abs)) throw new DockerizeError(`zip not found: ${abs}`);

  const zipSha256 = await sha256File(abs);
  const short = zipSha256.slice(0, 12);
  const extractDir = path.join(CACHE_DIR, short);

  // Always extract into a fresh folder so nothing stale is built.
  await rm(extractDir, { recursive: true, force: true });
  const files = await extractZip(abs, extractDir, opts.limits ?? DEFAULT_LIMITS);
  if (files.length === 0) throw new DockerizeError('the zip is empty');

  const dockerfile = findDockerfile(files);
  const contextDir = path.join(extractDir, path.posix.dirname(dockerfile));
  const imageTag = `agentproof-legacy:${short}`;

  const built = await buildImage(contextDir, path.join(extractDir, dockerfile), imageTag, opts.buildTimeoutMs);
  const buildLog = built.stdout + built.stderr;
  if (built.timedOut) throw new DockerizeError('docker build timed out', buildLog);
  if (built.exitCode !== 0) throw new DockerizeError(`docker build failed (exit ${built.exitCode})`, buildLog);

  return { zipPath: abs, zipSha256, extractDir, contextDir, dockerfile, files, imageTag, buildLog };
}

/** Lists files under a folder (relative, forward slashes); used by tests and the Analyzer. */
export async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter(e => e.isFile())
    .map(e => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort();
}
