import { Platform } from 'react-native';

/** The only place that knows the server address (SPEC §5). */
export function baseUrlFor(os: string): string {
  // The Android emulator reaches the host machine through 10.0.2.2.
  return os === 'android' ? 'http://10.0.2.2:4000' : 'http://localhost:4000';
}

export const API_BASE_URL = baseUrlFor(Platform.OS);

export const TIMEOUTS_MS = {
  default: 10_000,
  create: 10_000,
  authorize: 15_000,
} as const;
