export interface ElectronBackupFile {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  modifiedAt: string;
  kind: 'auto' | 'manual';
}

export interface ElectronPrinterInfo {
  name: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  status?: number;
}

export interface ElectronPrintSettingsPayload {
  defaultPrinterName?: string;
  paperSize?: 'A4' | 'A5' | 'Letter';
  orientation?: 'portrait' | 'landscape';
  margins?: 'none' | 'default' | 'minimum';
  color?: boolean;
  copies?: number;
  fitToPage?: boolean;
  silentPrint?: boolean;
}

export interface ElectronAPI {
  isElectron: boolean;
  saveBackup: (
    jsonContent: string,
    kind?: 'auto' | 'manual',
    customDir?: string
  ) => Promise<{
    ok: boolean;
    filePath?: string;
    fileName?: string;
    directory?: string;
    error?: string;
  }>;
  listBackups: (customDir?: string) => Promise<{
    ok: boolean;
    directory?: string;
    backups?: ElectronBackupFile[];
    error?: string;
  }>;
  restoreBackup: (filePath?: string) => Promise<{
    ok: boolean;
    canceled?: boolean;
    filePath?: string;
    jsonContent?: string;
    error?: string;
  }>;
  printToPDF: (options?: {
    defaultFileName?: string;
    companyName?: string;
    landscape?: boolean;
    rawLayout?: boolean;
    printRoute?: string;
    htmlContent?: string;
    paperSize?: 'A4' | 'A5' | 'Letter';
  }) => Promise<{
    ok: boolean;
    canceled?: boolean;
    filePath?: string;
    error?: string;
  }>;
  openFolder: (filePath: string) => Promise<{
    ok: boolean;
    error?: string;
  }>;
  getPrinters: () => Promise<{
    ok: boolean;
    printers?: ElectronPrinterInfo[];
    error?: string;
  }>;
  printDirect: (options?: {
    printRoute?: string;
    htmlContent?: string;
    printSettings?: ElectronPrintSettingsPayload;
  }) => Promise<{
    ok: boolean;
    error?: string;
  }>;
  selectFolder: (currentDir?: string) => Promise<{
    ok: boolean;
    canceled?: boolean;
    directory?: string;
  }>;
  getDefaultBackupFolder: () => Promise<{
    ok: boolean;
    directory?: string;
  }>;
  onRequestCloseBackup: (callback: () => void) => () => void;
  notifyCloseBackupDone: () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
