import type { UpdateStatus } from '../shared/updates.js';
export const RELEASES: string;
export function newer(candidate: string, current: string): boolean;
export function installed(root: string): Promise<{ home: string; release: { version: string } } | null>;
export function updateService(options: { root: string; version: string; directory: string; fetchLatest?: () => Promise<unknown> }): { status(force?: boolean): Promise<UpdateStatus>; install(): Promise<UpdateStatus> };
export function manifest(value: unknown): { schema: 1; version: string; assets: Record<string, { file: string; sha256: string; size: number }> };
export function installPackage(options: { home: string; release: unknown; archive?: string; platform?: string }): Promise<{ version: string; root: string }>;
