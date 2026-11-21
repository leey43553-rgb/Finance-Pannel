import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/database';
import type { UIMode } from '../db/types';

export function useUiMode() {
  const settings = useLiveQuery(() => db.settings.get('company_settings'));
  const uiMode: UIMode = settings?.uiMode || 'simple';
  return {
    settings,
    uiMode,
    isSimple: uiMode === 'simple',
    isAvance: uiMode === 'avance',
  };
}
