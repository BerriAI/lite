export function migrateBrowserStorage(storage: Storage) {
  try {
    const marker = 'speedrail:migrated-storage:v1';
    if (storage.getItem(marker)) return;
    for (const key of Object.keys(storage)) {
      if (!key.startsWith('lite:draft:v1:') && key !== 'lite.workspace-panel-open') continue;
      const destination = key.replace(/^lite/, 'speedrail');
      if (storage.getItem(destination) === null) storage.setItem(destination, storage.getItem(key)!);
    }
    storage.setItem(marker, 'true');
  } catch { /* Unavailable storage must not prevent opening the app. */ }
}
