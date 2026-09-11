import { LEGACY_NAMES } from '../../bin/legacy.mjs';
export function migrateBrowserStorage(storage: Storage) {
  try {
    const marker = 'litespeed:migrated-storage:v1';
    if (storage.getItem(marker)) return;
    for (const name of LEGACY_NAMES) for (const key of Object.keys(storage)) {
      if (!key.startsWith(`${name}:draft:v1:`) && key !== `${name}.workspace-panel-open`) continue;
      const destination = 'litespeed' + key.slice(name.length);
      if (storage.getItem(destination) === null) storage.setItem(destination, storage.getItem(key)!);
    }
    storage.setItem(marker, 'true');
  } catch { /* Unavailable storage must not prevent opening the app. */ }
}
