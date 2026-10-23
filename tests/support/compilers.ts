import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * The real compilers the ground-truth tests check the engine against: GCC-family cross compilers
 * and SDCC on the PATH (or inside WSL when the tests run on Windows), and MSVC on Windows.
 */
const run = promisify(execFile);

export const viaWsl =
  process.platform === "win32" &&
  (() => {
    try {
      execFileSync("wsl.exe", ["-e", "true"], { stdio: "ignore", timeout: 60_000 });
      return true;
    } catch {
      return false;
    }
  })();

const toWsl = (p: string) => p.replace(/^([A-Za-z]):[\\/]/, (_, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, "/");

/** Whether a POSIX tool (a cross compiler) can be run, natively or through WSL. */
export function hasTool(cmd: string): boolean {
  if (process.platform === "win32" && !viaWsl) return false;
  try {
    const argv = ["-c", `command -v ${cmd}`];
    if (viaWsl) execFileSync("wsl.exe", ["-e", "sh", ...argv], { stdio: "ignore" });
    else execFileSync("sh", argv, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Run a POSIX tool in `cwd`, through WSL on Windows. */
export async function tool(cmd: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = viaWsl
    ? await run("wsl.exe", ["--cd", toWsl(cwd), "-e", cmd, ...args], { maxBuffer: 64 * 1024 * 1024 })
    : await run(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** vcvarsall.bat of the newest Visual Studio with the C++ tools, found as Microsoft documents (vswhere). */
export const vcvarsall: string | null = (() => {
  if (process.platform !== "win32") return null;
  const vswhere = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!existsSync(vswhere)) return null;
  try {
    const path = execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" }).trim();
    const bat = join(path, "VC", "Auxiliary", "Build", "vcvarsall.bat");
    return path && existsSync(bat) ? bat : null;
  } catch {
    return null;
  }
})();

/** The environment vcvarsall sets up for `arch` (PATH to cl, INCLUDE, LIB), captured once. */
const msvcEnvironments = new Map<string, Promise<NodeJS.ProcessEnv>>();
function msvcEnvironment(arch: "x64" | "x86"): Promise<NodeJS.ProcessEnv> {
  let env = msvcEnvironments.get(arch);
  if (!env) {
    // cmd's own quoting: /s strips the outer quotes and leaves the rest as written.
    const line = `"call "${vcvarsall}" ${arch} >nul && set"`;
    env = run("cmd.exe", ["/d", "/s", "/c", line], { windowsVerbatimArguments: true, maxBuffer: 16 * 1024 * 1024 }).then(({ stdout }) =>
      Object.fromEntries(
        stdout.split(/\r?\n/).flatMap((l) => {
          const m = /^([^=]+)=(.*)$/.exec(l);
          return m ? [[m[1]!, m[2]!]] : [];
        }),
      ),
    );
    msvcEnvironments.set(arch, env);
  }
  return env;
}

/**
 * Run MSVC's `cl` for `arch` in `cwd`, in the environment vcvarsall sets up (so <stddef.h> and
 * <stdint.h> are found). Resolves to the exit code and the combined output: cl prints both the
 * diagnostics and /d1reportAllClassLayout's layouts on stdout.
 */
export async function msvc(arch: "x64" | "x86", args: string[], cwd: string): Promise<{ code: number; output: string }> {
  if (!vcvarsall) throw new Error("MSVC is not installed");
  const env = await msvcEnvironment(arch);
  try {
    const { stdout, stderr } = await run("cl.exe", ["/nologo", ...args], { cwd, env, maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, output: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, output: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

/**
 * The bytes of each external data symbol in a COFF object file (MSVC's .obj): from the symbol to
 * the next symbol in its section, or the section's end. Names lose the leading underscore that
 * 32-bit x86 adds to C names.
 */
export function readCoffSymbols(obj: Buffer): Map<string, number[]> {
  const sectionCount = obj.readUInt16LE(2);
  const symbolTable = obj.readUInt32LE(8);
  const symbolCount = obj.readUInt32LE(12);
  const optionalHeader = obj.readUInt16LE(16);
  const strings = symbolTable + symbolCount * 18;
  const sections = Array.from({ length: sectionCount }, (_, i) => {
    const at = 20 + optionalHeader + i * 40;
    return { size: obj.readUInt32LE(at + 16), data: obj.readUInt32LE(at + 20) };
  });
  const symbols: Array<{ name: string; section: number; value: number }> = [];
  for (let i = 0; i < symbolCount; i++) {
    const at = symbolTable + i * 18;
    const name =
      obj.readUInt32LE(at) === 0
        ? obj.toString("latin1", strings + obj.readUInt32LE(at + 4), obj.indexOf(0, strings + obj.readUInt32LE(at + 4)))
        : obj.toString("latin1", at, at + 8).replace(/\0.*$/, "");
    const section = obj.readInt16LE(at + 12);
    const storageClass = obj.readUInt8(at + 16);
    // IMAGE_SYM_CLASS_EXTERNAL, defined in a section.
    if (storageClass === 2 && section > 0) symbols.push({ name, section, value: obj.readUInt32LE(at + 8) });
    i += obj.readUInt8(at + 17);
  }
  const result = new Map<string, number[]>();
  for (const s of symbols) {
    const section = sections[s.section - 1]!;
    const next = Math.min(section.size, ...symbols.filter((o) => o.section === s.section && o.value > s.value).map((o) => o.value));
    result.set(s.name.replace(/^_/, ""), [...obj.subarray(section.data + s.value, section.data + next)]);
  }
  return result;
}
