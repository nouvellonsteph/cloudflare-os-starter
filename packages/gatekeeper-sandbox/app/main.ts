import { RpcTarget, newMessagePortRpcSession } from "capnweb";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { AppApi } from "../src/app-api.js";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

type Theme = { mode: "light" | "dark" };
type Entry = { name: string; type: string };
interface Host extends RpcTarget {
  readonly ui: AppApi;
  subscribeTheme(receiver: AppFrame): Promise<Theme>;
}

class AppFrame extends RpcTarget {
  setTheme(theme: Theme): void {
    document.documentElement.dataset.theme = theme.mode;
  }
}

const frame = new AppFrame();
const { port1, port2 } = new MessageChannel();
window.parent.postMessage({ type: "handshake" }, "*", [port2]);
const host = newMessagePortRpcSession<Host>(port1, frame);
const api = host.ui;
void host.subscribeTheme(frame).then(theme => frame.setTheme(theme)).catch(() => {});

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element ${id}.`);
  return node as T;
}

const status = element("status");
const error = element("error");
const tree = element("tree");
const saveFile = element<HTMLButtonElement>("save-file");
const editor = element<HTMLTextAreaElement>("editor");
const upload = element<HTMLInputElement>("file-input");
const attach = element<HTMLButtonElement>("attach");
const close = element<HTMLButtonElement>("close-terminal");
const directories = new Map<string, Entry[]>();
const expanded = new Set<string>([""]);
let selected: { path: string; type: string } | undefined;
let edited = "";
let fileBytes: Uint8Array<ArrayBuffer> | undefined;
let dirty = false;
let opened = false;
let working = false;

const terminalArea = element("terminal");
const terminal = new Terminal({
  fontSize: 13,
  fontFamily: "ui-monospace, Menlo, Consolas, monospace",
  cursorBlink: true,
  theme: { background: "#15161f", foreground: "#eeedf8", cursor: "#c3b9ff" },
});
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(terminalArea);
terminal.writeln("Open the workspace to start a Linux shell.");
let terminalId: string | undefined;
let cursor = 0;
let pollTimer: number | undefined;
let inputTimer: number | undefined;
let inputBuffer = "";
let sending = false;
let lastInteraction = 0;

function showError(cause: unknown): void {
  error.textContent = cause instanceof Error ? cause.message : String(cause);
  error.hidden = false;
}

function controls(): void {
  const file = selected?.type === "file";
  for (const id of ["refresh", "new-file", "new-folder", "upload", "save-stop"]) {
    element<HTMLButtonElement>(id).disabled = !opened || working;
  }
  element<HTMLButtonElement>("open").disabled = working;
  element<HTMLButtonElement>("copy-file").disabled = !fileBytes || working;
  for (const id of ["rename", "delete"]) {
    element<HTMLButtonElement>(id).disabled = !selected || working;
  }
  saveFile.disabled = !file || !dirty || working;
  attach.disabled = !opened || !!terminalId || working;
  close.disabled = !terminalId || working;
}

function task(fn: () => Promise<void>): void {
  if (working) return;
  error.hidden = true;
  working = true;
  controls();
  void fn().catch(showError).finally(() => {
    working = false;
    controls();
  });
}

function click(id: string, fn: () => Promise<void>): void {
  element(id).addEventListener("click", () => task(fn));
}

async function refreshStatus(): Promise<void> {
  const { running, saved } = await api.status();
  status.textContent = running ? "Running · /workspace"
    : saved ? "Stopped · saved files will be restored" : "Stopped · no saved files";
}

const child = (parent: string, name: string) => parent ? `${parent}/${name}` : name;
const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function drawTree(): void {
  function list(path: string): HTMLUListElement {
    const items = document.createElement("ul");
    items.className = "tree-list";
    for (const entry of directories.get(path) ?? []) {
      const fullPath = child(path, entry.name);
      const item = document.createElement("li");
      const button = document.createElement("button");
      const icon = document.createElement("span");
      const folder = entry.type === "directory";
      const isExpanded = expanded.has(fullPath);
      button.type = "button";
      button.className = "tree-entry";
      button.setAttribute("aria-current", String(fullPath === selected?.path));
      if (folder) button.setAttribute("aria-expanded", String(isExpanded));
      icon.className = "tree-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = folder ? (isExpanded ? "▾" : "▸") : "·";
      button.append(icon, document.createTextNode(entry.name));
      button.addEventListener("click", () => task(async () => {
        if (dirty && fullPath === selected?.path) return;
        if (!await canLeaveFile()) return;
        // File reads can fail. Keep the current editor and selection until the read succeeds.
        const bytes = entry.type === "file" ? Uint8Array.fromBase64(await api.readFile(fullPath)) : undefined;
        if (folder) {
          if (isExpanded) expanded.delete(fullPath);
          else {
            await loadDirectory(fullPath);
            expanded.add(fullPath);
          }
        }
        select(fullPath, entry.type, bytes);
        drawTree();
      }));
      item.append(button);
      if (folder && isExpanded) item.append(list(fullPath));
      items.append(item);
    }
    return items;
  }
  if (!directories.get("")?.length) {
    const message = document.createElement("p");
    message.className = "empty";
    message.textContent = "No files in /workspace.";
    tree.replaceChildren(message);
  } else {
    tree.replaceChildren(list(""));
  }
}

async function loadDirectory(path: string): Promise<void> {
  const entries = await api.listFiles(path);
  entries.sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name));
  directories.set(path, entries);
}

async function refreshDirectories(path: string): Promise<void> {
  await loadDirectory(path);
  for (const entry of directories.get(path) ?? []) {
    const pathToEntry = child(path, entry.name);
    if (entry.type === "directory" && expanded.has(pathToEntry)) await refreshDirectories(pathToEntry);
  }
}

async function refreshTree(): Promise<void> {
  await refreshDirectories("");
  drawTree();
}

function select(path?: string, type?: string, bytes?: Uint8Array<ArrayBuffer>): void {
  selected = path && type ? { path, type } : undefined;
  fileBytes = bytes;
  const message = element("editor-message");
  editor.hidden = !bytes;
  edited = "";
  message.textContent = path ? "Select a UTF-8 text file to edit." : "Select a file from the tree.";
  if (bytes) {
    try {
      edited = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (edited.includes("\0")) throw new Error("Binary file.");
    } catch {
      editor.hidden = true;
      message.textContent = "Binary file. Copy file copies its base64 representation.";
    }
  }
  editor.value = edited;
  editor.readOnly = false;
  dirty = false;
  message.hidden = !editor.hidden;
  element("filename").textContent = path || "Editor";
  controls();
}

function ask(title: string, message: string, initial?: string): Promise<string | undefined> {
  const dialog = element<HTMLDialogElement>("file-dialog");
  const input = element<HTMLInputElement>("entry-name");
  element("dialog-title").textContent = title;
  element("dialog-message").textContent = message;
  element("name-label").hidden = initial === undefined;
  input.disabled = initial === undefined;
  input.value = initial ?? "";
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener("close", () => {
    const value = input.value;
    if (dialog.returnValue !== "confirm") return resolve(undefined);
    if (initial !== undefined && (!value || value === "." || value === ".." || value.includes("/"))) {
      showError("Enter a single valid filename.");
      return resolve(undefined);
    }
    resolve(value);
  }, { once: true }));
}

const fileDialog = element<HTMLDialogElement>("file-dialog");
element("cancel").addEventListener("click", () => fileDialog.close("cancel"));
element("confirm").addEventListener("click", () => fileDialog.close("confirm"));
element("entry-name").addEventListener("keydown", event => {
  if (event.key === "Enter") fileDialog.close("confirm");
});

async function canLeaveFile(): Promise<boolean> {
  return !dirty || (await ask("Discard unsaved changes?", "The edited file has not been saved.")) !== undefined;
}

function selectedDirectory(): string {
  if (!selected) return "";
  return selected.type === "directory" ? selected.path : parent(selected.path);
}

async function ensureNewEntry(path: string, name: string): Promise<void> {
  if ((await api.listFiles(path)).some(entry => entry.name === name)) {
    throw new Error("A file or folder with that name already exists.");
  }
}

function disconnectTerminal(): void {
  terminalId = undefined;
  inputBuffer = "";
  window.clearTimeout(inputTimer);
  inputTimer = undefined;
  window.clearTimeout(pollTimer);
  controls();
}

async function poll(id: string): Promise<void> {
  if (document.hidden || Date.now() - lastInteraction > 2 * 60_000) {
    disconnectTerminal();
    terminal.writeln("\r\n[Terminal paused. Open terminal to reconnect.]");
    return;
  }
  try {
    const update = await api.readTerminal(id, cursor);
    if (terminalId !== id) return;
    cursor = update.cursor;
    if (update.reset) terminal.reset();
    if (update.text) terminal.write(update.text);
    if (update.ended) {
      disconnectTerminal();
      terminal.writeln("\r\n[Shell exited]");
      return;
    }
    pollTimer = window.setTimeout(() => void poll(id), 350);
  } catch (cause) {
    if (terminalId !== id) return;
    disconnectTerminal();
    showError(cause);
  }
}

async function openTerminal(): Promise<void> {
  fit.fit();
  const id = await api.openTerminal(terminal.cols, terminal.rows);
  terminal.reset();
  cursor = 0;
  terminalId = id;
  lastInteraction = Date.now();
  terminal.focus();
  void poll(id);
}

function queueInput(): void {
  if (!terminalId || !inputBuffer || inputTimer !== undefined || sending) return;
  inputTimer = window.setTimeout(() => {
    inputTimer = undefined;
    const id = terminalId;
    if (!id) return;
    const batch = inputBuffer.slice(0, 8192);
    inputBuffer = inputBuffer.slice(batch.length);
    sending = true;
    void api.sendTerminal(id, batch).catch(showError).finally(() => {
      sending = false;
      queueInput();
    });
  }, 150);
}

terminal.onData(data => {
  if (!terminalId) return;
  if (inputBuffer.length + data.length > 65536) return showError("The terminal input queue is full.");
  inputBuffer += data;
  queueInput();
});

let resizeTimer: number | undefined;
new ResizeObserver(() => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    fit.fit();
    if (terminalId) void api.resizeTerminal(terminalId, terminal.cols, terminal.rows).catch(showError);
  }, 200);
}).observe(terminalArea);

click("open", async () => {
  await refreshTree();
  opened = true;
  await refreshStatus();
  if (!terminalId) await openTerminal();
});
click("attach", openTerminal);
click("close-terminal", async () => {
  await api.stopTerminal();
  disconnectTerminal();
  terminal.writeln("\r\n[Shell closed]");
});
click("save-stop", async () => {
  if (dirty) throw new Error("Save the edited file first.");
  if (await ask("Save and stop?", "This ends the terminal and other running processes. Files will be restored when you reopen.") === undefined) return;
  await api.stopTerminal();
  disconnectTerminal();
  await api.saveAndStop();
  opened = false;
  directories.clear();
  select();
  tree.replaceChildren(Object.assign(document.createElement("p"), { className: "empty", textContent: "Open the workspace to browse /workspace." }));
  terminal.reset();
  terminal.writeln("Workspace stopped.");
  await refreshStatus();
});
click("refresh", refreshTree);
click("new-file", async () => {
  if (!await canLeaveFile()) return;
  const name = await ask("New file", "Create an empty file in the selected directory.", "");
  if (name === undefined) return;
  const directory = selectedDirectory();
  await ensureNewEntry(directory, name);
  const path = child(directory, name);
  await api.writeFile(path, "");
  select(path, "file", new Uint8Array());
  await refreshTree();
});
click("new-folder", async () => {
  const name = await ask("New folder", "Create a folder in the selected directory.", "");
  if (name === undefined) return;
  await api.makeDirectory(child(selectedDirectory(), name));
  await refreshTree();
});
element("upload").addEventListener("click", () => upload.click());
upload.addEventListener("change", () => task(async () => {
  const file = upload.files?.[0];
  upload.value = "";
  if (!file) return;
  if (file.size > 1024 * 1024) throw new Error("Files are limited to 1 MiB.");
  const directory = selectedDirectory();
  await ensureNewEntry(directory, file.name);
  const bytes = new Uint8Array(await file.arrayBuffer());
  await api.writeFile(child(directory, file.name), bytes.toBase64());
  await refreshTree();
}));
element("copy-file").addEventListener("click", () => {
  if (!fileBytes || working) return;
  const value = editor.hidden ? fileBytes.toBase64() : editor.value;
  void navigator.clipboard.writeText(value).then(() => {
    status.textContent = editor.hidden ? "Copied base64 file contents" : "Copied file contents";
  }).catch(showError);
});
click("rename", async () => {
  if (!selected || !await canLeaveFile()) return;
  const { path, type } = selected;
  const name = await ask("Rename entry", "Choose a new name in the same directory.", basename(path));
  if (name === undefined || name === basename(path)) return;
  const directory = parent(path);
  await ensureNewEntry(directory, name);
  await api.rename(path, name);
  select(child(directory, name), type, fileBytes);
  await refreshTree();
});
click("delete", async () => {
  if (!selected) return;
  if (await ask("Delete entry?", `Delete ${selected.path}? Folders must be empty.`) === undefined) return;
  await api.remove(selected.path);
  select();
  await refreshTree();
});
click("save-file", async () => {
  if (!selected || !dirty) return;
  const text = editor.value;
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 1024 * 1024) throw new Error("Files are limited to 1 MiB.");
  await api.writeFile(selected.path, bytes.toBase64());
  fileBytes = bytes;
  edited = text;
  dirty = editor.value !== edited;
});

editor.addEventListener("input", () => {
  dirty = editor.value !== edited;
  controls();
});
window.addEventListener("beforeunload", event => {
  if (dirty) event.preventDefault();
});
for (const activity of ["keydown", "pointerdown"]) {
  window.addEventListener(activity, () => { lastInteraction = Date.now(); });
}
window.addEventListener("pagehide", disconnectTerminal);
controls();
task(refreshStatus);
