/** @jsxImportSource @opentui/react */
import { createContext, useContext } from 'react';
import type { Theme } from './theme.js';
import { CONFIG_DEFAULTS, type TuiConfig } from './tuiConfig.js';
export const ConfigContext = createContext<TuiConfig>(CONFIG_DEFAULTS);
export const useConfig = () => useContext(ConfigContext);
export const ThemeContext = createContext<Theme | null>(null);
export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('Missing terminal theme');
  return theme;
}
