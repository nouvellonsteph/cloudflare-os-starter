/** The type of a direct child of a directory. */
export type WorkspaceEntry = { name: string; type: string };

/** Command output and exit status. A truncated result omits output beyond the workspace limit. */
export type CommandResult = { stdout: string; stderr: string; exitCode: number; truncated: boolean };

/** An approved command's state. */
export type CommandStatus =
  | { state: "pending" | "running" | "rejected" | "interrupted" | "expired" }
  | { state: "finished"; result: CommandResult };

/** Access to the owner's Linux workspace. Paths are relative to /workspace. */
export interface SandboxSession {
  /** List the immediate children of a directory. An empty path lists the workspace root. */
  listFiles(path?: string): Promise<WorkspaceEntry[]>;
  /** Read a UTF-8 text file. */
  readFile(path: string): Promise<string>;
  /** Request creation or replacement of a UTF-8 text file. Its parent directory must exist. */
  writeFile(path: string, content: string): Promise<void>;
  /** Request a Linux command using an argument vector. Returns its reference number. */
  runCommand(argv: string[], cwd?: string): Promise<number>;
  /** Read the command's state and, once available, its bounded output. */
  commandStatus(id: number): Promise<CommandStatus>;
}
