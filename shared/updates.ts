export interface UpdateStatus {
  currentVersion: string;
  latestVersion?: string;
  available: boolean;
  packaged: boolean;
  installedVersion?: string;
  restartRequired: boolean;
  checkedAt?: number;
  error?: string;
  releaseUrl: string;
  command: string;
}
