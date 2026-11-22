/** Browser capability for the authenticated owner's private sandbox. */
export interface AppApi {
  status(): Promise<{ running: boolean; saved: boolean }>;
  listFiles(path: string): Promise<{ name: string; type: string }[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, base64: string): Promise<void>;
  makeDirectory(path: string): Promise<void>;
  rename(path: string, name: string): Promise<void>;
  remove(path: string): Promise<void>;
  openTerminal(cols: number, rows: number): Promise<string>;
  readTerminal(id: string, cursor: number): Promise<{ text: string; cursor: number; ended: boolean; reset: boolean }>;
  sendTerminal(id: string, data: string): Promise<void>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
  stopTerminal(): Promise<void>;
  saveAndStop(): Promise<void>;
}
