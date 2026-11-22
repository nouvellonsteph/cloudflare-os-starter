import { Files } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { CommandResult, WorkspaceEntry } from "./types.js";

export type SandboxEnv = {
  WORKSPACES: DurableObjectNamespace<SandboxWorkspace>;
  SANDBOX_INSTANCE_TYPE?: string;
};

const ROOT = "/workspace";
const IDLE_MS = 10 * 60_000;
const FILE_LIMIT = 1024 * 1024;
const OUTPUT_LIMIT = 12 * 1024;
const TERMINAL_HISTORY = 128 * 1024;
const SIZES = ["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"] as const;

type Terminal = {
  id: string;
  process: ExecProcess;
  start: number;
  text: string;
  ended: boolean;
  input: WritableStreamDefaultWriter | null;
};

/** Resolve an app-relative path within the workspace directory. */
export function workspacePath(path: string, rootAllowed = false): string {
  if (path === "" && rootAllowed) return ROOT;
  if (path.length > 4096 || path.includes("\0") ||
      path.split("/").some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error("Use a relative workspace path without empty or parent segments.");
  }
  return `${ROOT}/${path}`;
}

function terminalSize(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) ||
      cols < 2 || cols > 500 || rows < 2 || rows > 300) {
    throw new Error("Invalid terminal size.");
  }
}

async function readFileBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const buffer = new Uint8Array(FILE_LIMIT);
  const reader = stream.getReader();
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return buffer.subarray(0, length);
      if (length + value.length > FILE_LIMIT) throw new Error("Files are limited to 1 MiB.");
      buffer.set(value, length);
      length += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readCommandOutput(stream: ReadableStream | null) {
  const output = new Uint8Array(OUTPUT_LIMIT);
  let length = 0;
  let truncated = false;
  if (stream) {
    for await (const chunk of stream as ReadableStream<Uint8Array>) {
      const bytes = chunk.subarray(0, OUTPUT_LIMIT - length);
      output.set(bytes, length);
      length += bytes.length;
      truncated ||= chunk.length > bytes.length;
    }
  }
  return { text: new TextDecoder().decode(output.subarray(0, length)), truncated };
}

/** Owns the container, live terminal and last saved filesystem for one Sandbox account. */
@validateRpc()
export class SandboxWorkspace extends DurableObject<SandboxEnv> {
  #container: Container;
  #files: Files;
  #starting?: Promise<void>;
  #saving = false;
  #operations = 0;
  #terminal?: Terminal;
  #opening?: Promise<string>;

  constructor(ctx: DurableObjectState, env: SandboxEnv) {
    super(ctx, env);
    if (!ctx.container) throw new Error("The Sandbox container binding is missing.");
    this.#container = ctx.container;
    this.#files = new Files(this.#container);
    if (this.#container.running) {
      void ctx.blockConcurrencyWhile(() => this.#container.setInactivityTimeout(IDLE_MS));
    }
  }

  /** Reject requests after the Workshop connection has been revoked. */
  async assertLive(): Promise<void> {
    if (this.ctx.storage.kv.get("revoked")) throw new Error("Sandbox connection revoked.");
  }

  async #start(): Promise<void> {
    if (this.#starting) return this.#starting;
    if (this.#container.running) return;
    this.#terminal = undefined;
    const snapshot = this.ctx.storage.kv.get<string>("snapshot");
    const instance = SIZES.find(size => size === (this.env.SANDBOX_INSTANCE_TYPE ?? "standard-1"));
    if (!instance) throw new Error("Invalid SANDBOX_INSTANCE_TYPE.");
    this.#container.start({
      ...(snapshot ? { containerSnapshot: { id: snapshot } } : { image: this.#container.images.workspace }),
      entrypoint: ["sleep", "infinity"],
      enableInternet: false,
      instance,
    });
    this.#starting = this.#container.setInactivityTimeout(IDLE_MS);
    try {
      await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async #use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#saving) throw new Error("The workspace is being saved.");
    this.#operations++;
    try {
      await this.assertLive();
      await this.#start();
      await this.assertLive();
      return await fn();
    } finally {
      this.#operations--;
    }
  }

  /** List the immediate children of a workspace directory. */
  async listFiles(path: string): Promise<WorkspaceEntry[]> {
    const directory = workspacePath(path, true);
    return this.#use(async () => {
      const entries = await this.#files.readDirectory(directory, { signal: AbortSignal.timeout(10_000) });
      if (entries.length > 2000) throw new Error("This directory has more than 2,000 entries.");
      return entries.map(({ name, type }) => ({ name, type }));
    });
  }

  /** Read a regular file and return it as base64 for the browser bridge. */
  async readFile(path: string): Promise<string> {
    const filename = workspacePath(path);
    return this.#use(async () => {
      const options = { signal: AbortSignal.timeout(10_000) };
      const info = await this.#files.lstat(filename, options);
      if (info.type !== "file" || info.size > FILE_LIMIT) throw new Error("Select a regular file of at most 1 MiB.");
      const response = await this.#files.readFile(filename, options);
      return (await readFileBytes(response.body!)).toBase64();
    });
  }

  /** Write a whole file using an atomic rename within its directory. */
  async writeFile(path: string, base64: string): Promise<void> {
    const target = workspacePath(path);
    if (base64.length > Math.ceil(FILE_LIMIT / 3) * 4) throw new Error("Files are limited to 1 MiB.");
    const data = Uint8Array.fromBase64(base64);
    if (data.length > FILE_LIMIT) throw new Error("Files are limited to 1 MiB.");
    await this.#use(async () => {
      const temporary = `${target.slice(0, target.lastIndexOf("/"))}/.upload-${crypto.randomUUID()}`;
      const options = { signal: AbortSignal.timeout(10_000) };
      try {
        await this.#files.writeFile(temporary, data, options);
        await this.#files.rename(temporary, target, options);
      } catch (error) {
        await this.#files.remove(temporary, { force: true, signal: AbortSignal.timeout(2000) }).catch(() => {});
        throw error;
      }
    });
  }

  /** Make an empty directory. */
  async makeDirectory(path: string): Promise<void> {
    const target = workspacePath(path);
    await this.#use(() => this.#files.mkdir(target, { signal: AbortSignal.timeout(10_000) }));
  }

  /** Rename a file or directory in the same parent directory. */
  async rename(path: string, name: string): Promise<void> {
    if (name.includes("/")) throw new Error("Enter a single filename.");
    workspacePath(name);
    const target = workspacePath(path);
    const destination = `${target.slice(0, target.lastIndexOf("/"))}/${name}`;
    await this.#use(() => this.#files.rename(target, destination, { signal: AbortSignal.timeout(10_000) }));
  }

  /** Remove a file or empty directory. */
  async remove(path: string): Promise<void> {
    const target = workspacePath(path);
    await this.#use(() => this.#files.remove(target, { signal: AbortSignal.timeout(10_000) }));
  }

  /** Execute an approved command with a bounded runtime and captured output. */
  async runCommand(argv: string[], cwd: string): Promise<CommandResult> {
    const directory = workspacePath(cwd, true);
    return this.#use(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      try {
        const process = await this.#container.exec(argv, { cwd: directory, signal: controller.signal });
        const exit = process.exitCode.finally(() => clearTimeout(timer));
        const [stdout, stderr, exitCode] = await Promise.all([
          readCommandOutput(process.stdout),
          readCommandOutput(process.stderr),
          exit,
        ]);
        return { stdout: stdout.text, stderr: stderr.text, exitCode, truncated: stdout.truncated || stderr.truncated };
      } finally {
        clearTimeout(timer);
      }
    });
  }

  /** Start or reconnect to the running interactive shell. */
  async openTerminal(cols: number, rows: number): Promise<string> {
    terminalSize(cols, rows);
    if (this.#opening) return this.#opening;
    this.#opening = this.#use(async () => {
      if (this.#terminal && !this.#terminal.ended) {
        this.#terminal.process.resize(cols, rows);
        return this.#terminal.id;
      }
      const process = await this.#container.exec(["/bin/bash", "-i"], {
        cwd: ROOT, pty: { cols, rows }, env: { TERM: "xterm-256color", HOME: "/home/node" },
      });
      const terminal: Terminal = {
        id: crypto.randomUUID(), process, start: 0, text: "", ended: false,
        input: process.stdin?.getWriter() ?? null,
      };
      this.#terminal = terminal;
      void this.#collect(terminal);
      return terminal.id;
    });
    try {
      return await this.#opening;
    } finally {
      this.#opening = undefined;
    }
  }

  async #collect(terminal: Terminal): Promise<void> {
    const decoder = new TextDecoder();
    const append = (text: string) => {
      const history = terminal.text + text;
      const trim = Math.max(0, history.length - TERMINAL_HISTORY);
      terminal.start += trim;
      terminal.text = history.slice(trim);
    };
    const exited = terminal.process.exitCode.catch(() => null);
    try {
      for await (const chunk of terminal.process.stdout as ReadableStream<Uint8Array>) {
        append(decoder.decode(chunk, { stream: true }));
      }
      append(decoder.decode());
      await exited;
    } catch {
      append("\r\n[Terminal disconnected]\r\n");
    } finally {
      terminal.ended = true;
      terminal.input?.releaseLock();
      terminal.input = null;
    }
  }

  #getTerminal(id: string): Terminal {
    if (this.#terminal?.id !== id) throw new Error("The terminal is no longer available. Reconnect to open a shell.");
    return this.#terminal;
  }

  /** Read new terminal output and acknowledge its cursor. */
  async readTerminal(id: string, cursor: number): Promise<{ text: string; cursor: number; ended: boolean; reset: boolean }> {
    await this.assertLive();
    const terminal = this.#getTerminal(id);
    const end = terminal.start + terminal.text.length;
    const reset = cursor < terminal.start || cursor > end;
    return { text: terminal.text.slice(reset ? 0 : cursor - terminal.start), cursor: end, ended: terminal.ended, reset };
  }

  /** Forward input from the browser to the shell. */
  async sendTerminal(id: string, text: string): Promise<void> {
    if (text.length > 16_384) throw new Error("Terminal input is too large.");
    await this.assertLive();
    const terminal = this.#getTerminal(id);
    if (!terminal.input || terminal.ended) throw new Error("The terminal has closed.");
    await terminal.input.write(new TextEncoder().encode(text));
  }

  /** Update the PTY dimensions when the app layout changes. */
  async resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
    terminalSize(cols, rows);
    await this.assertLive();
    const terminal = this.#getTerminal(id);
    if (!terminal.ended) terminal.process.resize(cols, rows);
  }

  /** End the interactive shell. */
  async stopTerminal(): Promise<void> {
    await this.assertLive();
    if (this.#opening) await this.#opening;
    const terminal = this.#terminal;
    if (terminal && !terminal.ended) {
      terminal.process.kill(9);
      await terminal.process.exitCode.catch(() => {});
      terminal.ended = true;
    }
  }

  /** Snapshot the filesystem and release the running container. */
  async saveAndStop(): Promise<void> {
    if (this.#saving || this.#operations || (this.#terminal && !this.#terminal.ended)) {
      throw new Error("Close the terminal and wait for running operations before saving.");
    }
    this.#saving = true;
    try {
      await this.assertLive();
      if (!this.#container.running) throw new Error("The workspace already stopped. Only previously saved files can be restored.");
      const snapshot = await this.#container.snapshotContainer();
      this.ctx.storage.kv.put("snapshot", snapshot.id);
      await this.ctx.storage.sync();
      if (this.#container.running) await this.#container.destroy();
    } finally {
      this.#saving = false;
    }
  }

  /** Show container and saved-state status without starting compute. */
  async status(): Promise<{ running: boolean; saved: boolean }> {
    await this.assertLive();
    return { running: this.#container.running, saved: Boolean(this.ctx.storage.kv.get("snapshot")) };
  }

  /** Permanently disable the connection and stop its active instance. */
  async revoke(): Promise<void> {
    this.ctx.storage.kv.put("revoked", true);
    if (this.#container.running) await this.#container.destroy();
  }
}
