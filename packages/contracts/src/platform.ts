/**
 * Host abstraction so UI code never touches localStorage / downloads directly.
 * Today only the web adapter exists; a desktop shell would supply its own.
 */
export interface PlatformApi {
  readonly kind: "web";
  readSavedState<T>(key: string): T | undefined;
  writeSavedState<T>(key: string, value: T): void;
  removeSavedState(key: string): void;
  saveFile(filename: string, data: Blob | string, mimeType?: string): void;
}
