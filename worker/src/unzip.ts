// Safe extraction of an untrusted legacy-system zip.
//
// Rejects: absolute paths, drive letters, ".." segments (zip-slip), symlinks,
// too many entries, and archives or files over the size limits. yauzl also
// checks that each entry's real size matches its header (zip bombs).

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

export interface UnzipLimits {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_LIMITS: UnzipLimits = {
  maxEntries: 5_000,
  maxFileBytes: 50 * 1024 * 1024,
  maxTotalBytes: 300 * 1024 * 1024,
};

export class UnsafeZipError extends Error {}

// yauzl rejects some unsafe names itself ("invalid relative path", "absolute
// path"); report those as UnsafeZipError too.
function asUnsafe(err: Error): Error {
  return /invalid relative path|absolute path|invalid characters in fileName/i.test(err.message)
    ? new UnsafeZipError(err.message)
    : err;
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** Normalized relative path for an entry, or throws if it would escape destDir. */
export function safeEntryPath(destDir: string, entryName: string): string {
  const name = entryName.replace(/\\/g, '/');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
    throw new UnsafeZipError(`absolute path in zip: ${entryName}`);
  }
  if (name.split('/').some(seg => seg === '..')) {
    throw new UnsafeZipError(`".." in zip path: ${entryName}`);
  }
  const target = path.resolve(destDir, name);
  const root = path.resolve(destDir) + path.sep;
  if (!target.startsWith(root)) {
    throw new UnsafeZipError(`zip path escapes the extract folder: ${entryName}`);
  }
  return target;
}

/** Extracts zipPath into destDir (must be empty or new). Returns the relative file paths. */
export async function extractZip(
  zipPath: string,
  destDir: string,
  limits: UnzipLimits = DEFAULT_LIMITS
): Promise<string[]> {
  await mkdir(destDir, { recursive: true });
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(zipPath, { lazyEntries: true, validateEntrySizes: true }, (err, z) =>
      err || !z ? reject(err ?? new Error('could not open zip')) : resolve(z)
    )
  );

  if (zip.entryCount > limits.maxEntries) {
    zip.close();
    throw new UnsafeZipError(`zip has ${zip.entryCount} entries (limit ${limits.maxEntries})`);
  }

  const files: string[] = [];
  let total = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', (err: Error) => reject(asUnsafe(err)));
      zip.on('end', resolve);
      zip.on('entry', (entry: yauzl.Entry) => {
        (async () => {
          const target = safeEntryPath(destDir, entry.fileName);
          const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;
          if (mode === S_IFLNK) throw new UnsafeZipError(`symlink in zip: ${entry.fileName}`);

          if (entry.fileName.endsWith('/')) {
            await mkdir(target, { recursive: true });
            return;
          }
          if (entry.uncompressedSize > limits.maxFileBytes) {
            throw new UnsafeZipError(`${entry.fileName} is too large (${entry.uncompressedSize} bytes)`);
          }
          total += entry.uncompressedSize;
          if (total > limits.maxTotalBytes) {
            throw new UnsafeZipError(`zip expands past ${limits.maxTotalBytes} bytes`);
          }
          await mkdir(path.dirname(target), { recursive: true });
          const stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
            zip.openReadStream(entry, (err, s) => (err || !s ? rej(err ?? new Error('no stream')) : res(s)))
          );
          await pipeline(stream, createWriteStream(target, { flags: 'wx' }));
          files.push(path.relative(destDir, target).split(path.sep).join('/'));
        })().then(() => zip.readEntry(), reject);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  return files.sort();
}
