/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// logging.ts — operational logging: one line per event, structured, greppable.
//
// Deliberately small. It writes JSON to stdout, which is what a process manager
// or a hosting platform collects; swapping in a real sink is one function.
//
// It REDACTS by field name rather than by hoping nobody logs a password, and it
// never logs a request body: a purchase request contains a job number and a
// vendor price, and the log is not the place for either.
// ---------------------------------------------------------------------------

const REDACTED = ['password', 'token', 'secret', 'authorization', 'cookie', 'anonKey', 'serviceRoleKey'];

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, event: string, fields: Record<string, unknown> = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...redact(fields),
  };
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED.some((r) => key.toLowerCase().includes(r.toLowerCase()))) {
      out[key] = '[redacted]';
      continue;
    }
    // Email addresses identify a person; the local part is enough to trace a
    // sign-in problem without printing the whole address into a shared log.
    if (key.toLowerCase().includes('email') && typeof value === 'string' && value.includes('@')) {
      const [local, domain] = value.split('@');
      out[key] = `${local.slice(0, 2)}***@${domain}`;
      continue;
    }
    out[key] = value;
  }
  return out;
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit('debug', event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit('error', event, fields),
};
