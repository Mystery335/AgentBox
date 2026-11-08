// Turns the legacy-system zip into a runnable Docker image.
//
//   zip  ->  .cache/legacy/<sha12>/  (safe extract)
//        ->  use the zip's Dockerfile, or generate one from the detected
//            languages (.cache/legacy/<sha12>.Dockerfile)
//        ->  docker build -t agentproof-legacy:<sha12>
//
// Same zip -> same folder and image tag, so re-running is cheap and results
// are traceable to the exact input.

import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker, type ExecResult } from './docker.ts';
import { extractZip, type UnzipLimits, DEFAULT_LIMITS } from './unzip.ts';
import { scanProject } from './analyzer/scan.ts';
import { detectLanguages, generateDockerfile } from './analyzer/runtime.ts';

export const AGENTBOX_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE_DIR = path.join(AGENTBOX_ROOT, '.cache', 'legacy');
const DOCKERFILE_NAMES = new Set(['dockerfile', 'containerfile']);

export interface LegacyBundle {
  zipPath: string;
  zipSha256: string;
  extractDir: string;
  /** Build context: the folder that holds the Dockerfile (the extract folder for a generated one). */
  contextDir: string;
  /** Dockerfile path relative to extractDir (a generated one lives outside it, "../<sha12>.Dockerfile"). */
  dockerfile: string;
  /** True when the zip had no Dockerfile and one was generated. */
  dockerfileGenerated: boolean;
  dockerfileText: string;
  /** Toolchain description for run.legacy_runtime. */
  legacyRuntime: string;
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

/**
 * Picks the Dockerfile: the shallowest one; error if there are several at
 * that depth. Returns undefined when the zip has none (one is generated).
 */
export function findDockerfile(files: string[]): string | undefined {
  const candidates = files.filter(f => DOCKERFILE_NAMES.has(path.posix.basename(f).toLowerCase()));
  if (candidates.length === 0) return undefined;
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

  const imageTag = `agentproof-legacy:${short}`;
  const found = findDockerfile(files);
  let contextDir: string;
  let dockerfilePath: string;
  let dockerfileText: string;
  let legacyRuntime: string;

  if (found) {
    contextDir = path.join(extractDir, path.posix.dirname(found));
    dockerfilePath = path.join(extractDir, found);
    dockerfileText = await readFile(dockerfilePath, 'utf8');
    legacyRuntime = `provided Dockerfile (${found})`;
  } else {
    // No Dockerfile: detect the languages and generate one with their
    // toolchains. It's written next to the extract folder, not into it, so
    // the extracted project stays exactly what was uploaded.
    const scan = await scanProject(extractDir, files);
    const languages = detectLanguages(scan.inventory);
    const gen = generateDockerfile(languages);
    contextDir = extractDir;
    dockerfilePath = path.join(CACHE_DIR, `${short}.Dockerfile`);
    dockerfileText = gen.dockerfile;
    legacyRuntime = gen.runtime;
    await writeFile(dockerfilePath, dockerfileText);
  }

  const built = await buildImage(contextDir, dockerfilePath, imageTag, opts.buildTimeoutMs);
  const buildLog = built.stdout + built.stderr;
  if (built.timedOut) throw new DockerizeError('docker build timed out', buildLog);
  if (built.exitCode !== 0) throw new DockerizeError(`docker build failed (exit ${built.exitCode})`, buildLog);

  return {
    zipPath: abs,
    zipSha256,
    extractDir,
    contextDir,
    dockerfile: found ?? path.relative(extractDir, dockerfilePath).split(path.sep).join('/'),
    dockerfileGenerated: !found,
    dockerfileText,
    legacyRuntime,
    files,
    imageTag,
    buildLog,
  };
}

/** Lists files under a folder (relative, forward slashes); used by tests and the Analyzer. */
export async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter(e => e.isFile())
    .map(e => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort();
}
