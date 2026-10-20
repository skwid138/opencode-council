// Council-only. Fresh Docker CLI state per docker gate (B, C): DOCKER_CONFIG and HOME
// are new, empty, 0700 directories in the session dir that did not exist before (in
// any form, symlinks included), and are verified empty right before the first docker
// call. One pair per gate so Gate C never reuses Gate B's CLI state.
import { lstat, mkdir, readdir } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

export function dockerDirs(sessionDir, gate) {
  if (!isAbsolute(sessionDir)) throw new Error("session dir must be an absolute path");
  const suffix = String(gate).toLowerCase();
  return { configDir: join(sessionDir, `docker-config-${suffix}`), home: join(sessionDir, `docker-home-${suffix}`) };
}

const present = async (path) => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

/** Refuses if either path exists (dir, file, or symlink); creates both exclusively with mode 0700. */
export async function prepareDockerDirs({ configDir, home }) {
  for (const dir of [configDir, home]) if (await present(dir)) throw new Error(`refusing: ${basename(dir)} already exists (${dir}); Docker CLI state must be fresh`);
  for (const dir of [configDir, home]) await mkdir(dir, { mode: 0o700 });
}

/** Right before the first docker call: both must still be real, empty directories. */
export async function verifyDockerDirsEmpty({ configDir, home }) {
  for (const dir of [configDir, home]) {
    const info = await lstat(dir).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) throw new Error(`refusing: ${basename(dir)} must be a real directory (${dir})`);
    const entries = await readdir(dir);
    if (entries.length > 0) throw new Error(`refusing: ${basename(dir)} must be empty before the first docker call (found ${entries.slice(0, 5).join(", ")})`);
  }
}
