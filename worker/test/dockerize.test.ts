import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { crc32 } from 'node:zlib';
import { findDockerfile, DockerizeError } from '../src/dockerize.ts';
import { extractZip, safeEntryPath, UnsafeZipError } from '../src/unzip.ts';

// Minimal zip writer (stored, no compression). `mode` sets unix file type bits.
function makeZip(entries: { name: string; data?: string; mode?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data ?? '', 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by unix
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'agentproof-test-'));
after(() => rm(tmpRoot, { recursive: true, force: true }));
let n = 0;
async function zipFile(entries: Parameters<typeof makeZip>[0]): Promise<{ zip: string; dest: string }> {
  n += 1;
  const zip = path.join(tmpRoot, `t${n}.zip`);
  await writeFile(zip, makeZip(entries));
  return { zip, dest: path.join(tmpRoot, `out${n}`) };
}

describe('extractZip', () => {
  it('extracts nested files', async () => {
    const { zip, dest } = await zipFile([
      { name: 'app/', mode: 0o040755 },
      { name: 'app/Dockerfile', data: 'FROM busybox\n' },
      { name: 'app/src/PAY.cbl', data: '       IDENTIFICATION DIVISION.\n' },
    ]);
    const files = await extractZip(zip, dest);
    assert.deepEqual(files, ['app/Dockerfile', 'app/src/PAY.cbl']);
    assert.equal(await readFile(path.join(dest, 'app/Dockerfile'), 'utf8'), 'FROM busybox\n');
  });

  it('rejects ".." (zip-slip)', async () => {
    const { zip, dest } = await zipFile([{ name: '../evil.txt', data: 'x' }]);
    await assert.rejects(extractZip(zip, dest), UnsafeZipError);
  });

  it('rejects absolute paths', async () => {
    const { zip, dest } = await zipFile([{ name: '/etc/passwd', data: 'x' }]);
    await assert.rejects(extractZip(zip, dest), /absolute path|invalid relative path/);
  });

  it('rejects symlinks', async () => {
    const { zip, dest } = await zipFile([{ name: 'link', data: '/etc/passwd', mode: 0o120777 }]);
    await assert.rejects(extractZip(zip, dest), /symlink/);
  });

  it('enforces size limits', async () => {
    const { zip, dest } = await zipFile([{ name: 'big.txt', data: 'x'.repeat(100) }]);
    await assert.rejects(
      extractZip(zip, dest, { maxEntries: 10, maxFileBytes: 50, maxTotalBytes: 1000 }),
      /too large/
    );
  });
});

describe('safeEntryPath', () => {
  it('allows normal paths and blocks escapes', () => {
    const d = path.join(tmpRoot, 'x');
    assert.equal(safeEntryPath(d, 'a/b.txt'), path.join(d, 'a', 'b.txt'));
    assert.throws(() => safeEntryPath(d, 'a/../../b'), UnsafeZipError);
    assert.throws(() => safeEntryPath(d, 'C:/Windows/x'), UnsafeZipError);
    assert.throws(() => safeEntryPath(d, '..\\x'), UnsafeZipError);
  });
});

describe('findDockerfile', () => {
  it('picks the shallowest Dockerfile', () => {
    assert.equal(findDockerfile(['sys/Dockerfile', 'sys/tests/Dockerfile', 'sys/a.cbl']), 'sys/Dockerfile');
  });
  it('accepts Containerfile and any case', () => {
    assert.equal(findDockerfile(['dockerfile']), 'dockerfile');
    assert.equal(findDockerfile(['x/Containerfile']), 'x/Containerfile');
  });
  it('errors when missing or ambiguous', () => {
    assert.throws(() => findDockerfile(['a.cbl']), DockerizeError);
    assert.throws(() => findDockerfile(['a/Dockerfile', 'b/Dockerfile']), /several/);
  });
});
