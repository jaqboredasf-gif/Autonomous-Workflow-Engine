// ---------------------------------------------------------------------------
// auth/index.ts — which credential provider is running.
//
// One line decides it, and nothing above this file can tell the difference:
// `AUTH_PROVIDER=supabase` with a URL and keys uses Supabase Auth; anything
// else uses the local scrypt store so the pilot still has real authentication
// with no external dependency.
// ---------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';

import type { AuthPort } from '../../application/ports.ts';
import type { AppConfig } from '../env.ts';
import { localAuthAdapter } from './local-auth.ts';
import { supabaseAuthAdapter } from './supabase-auth.ts';

export function authAdapter(db: DatabaseSync, config: AppConfig): AuthPort {
  return config.authProvider === 'supabase' ? supabaseAuthAdapter(db, config) : localAuthAdapter(db);
}

export { localAuthAdapter, supabaseAuthAdapter };
