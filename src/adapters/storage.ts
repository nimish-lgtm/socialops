import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sha256 } from '../lib/ids';
import type { MediaInspector, StoragePort } from '../ports';

/** Content-addressed local storage, one folder per workspace. Refs never cross workspaces. */
export class DiskStorage implements StoragePort {
  constructor(private root: string) {}
  async put(workspaceId: string, data: Buffer, mime: string) {
    const hash = sha256(data);
    const ext = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
    const rel = path.join(workspaceId.replace(/[^a-zA-Z0-9_-]/g, ''), `${hash}.${ext}`);
    const full = path.join(this.root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
    return { ref: rel, sha256: hash, bytes: data.length };
  }
  async get(ref: string): Promise<Buffer> { return fs.readFile(this.resolve(ref)); }
  async remove(ref: string): Promise<void> { await fs.rm(this.resolve(ref), { force: true }); }
  resolve(ref: string): string {
    const full = path.resolve(this.root, ref);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error('bad_ref');
    return full;
  }
  async removeWorkspace(workspaceId: string): Promise<void> {
    await fs.rm(path.join(this.root, workspaceId.replace(/[^a-zA-Z0-9_-]/g, '')), { recursive: true, force: true });
  }
}

const run = promisify(execFile);

/** ffprobe-based QC. Unknown values stay null rather than guessed. */
export class FfprobeInspector implements MediaInspector {
  async inspect(file: string, mime: string) {
    if (!mime.startsWith('video/') && !mime.startsWith('image/')) return { durationS: null, width: null, height: null, hasAudio: null };
    try {
      const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', file], { timeout: 20_000 });
      const j = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string; width?: number; height?: number }>; format?: { duration?: string } };
      const v = j.streams?.find((s) => s.codec_type === 'video');
      const dur = Number(j.format?.duration);
      return {
        durationS: mime.startsWith('video/') && Number.isFinite(dur) ? dur : null,
        width: v?.width ?? null,
        height: v?.height ?? null,
        hasAudio: mime.startsWith('video/') ? !!j.streams?.some((s) => s.codec_type === 'audio') : null,
      };
    } catch {
      return { durationS: null, width: null, height: null, hasAudio: null };
    }
  }
}

/** Test double: returns whatever the test sets. */
export class FakeInspector implements MediaInspector {
  next: { durationS: number | null; width: number | null; height: number | null; hasAudio: boolean | null } = { durationS: 30, width: 1080, height: 1920, hasAudio: true };
  async inspect() { return this.next; }
}
