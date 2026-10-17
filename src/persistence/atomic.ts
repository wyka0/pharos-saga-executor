import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function replaceFile(temp: string, target: string): Promise<void> {
  try {
    await fs.rename(temp, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'EACCES') throw error;
    // Windows can refuse to replace an open file; retry once after unlinking.
    await fs.rm(target, { force: true });
    await fs.rename(temp, target);
  }
}

export async function atomicWriteText(file: string, text: string): Promise<void> {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await fs.open(temp, 'w');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await replaceFile(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
  // Best-effort durability of the directory entry. Not all platforms allow it.
  try {
    const dirHandle = await fs.open(path.dirname(file), 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Directory fsync is not supported on every filesystem (notably Windows).
  }
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJsonIfExists<T>(file: string): Promise<T | null> {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
