// ---------------------------------------------------------------------------
// login-strings.ts — the sign-in screen in English and Spanish.
//
// Screen 01 requires an English/Español entry point. The application has no
// message catalogue yet (domain/status.mjs returns translation KEYS that
// nothing resolves), and inventing one for ten strings would be the wrong
// shape to build the real thing on.
//
// So this is deliberately scoped to the front door: the one screen a person
// meets before they have any settings, and the one place where not reading
// English means not getting in at all. When a catalogue arrives, this table is
// deleted and the keys move into it.
// ---------------------------------------------------------------------------

export type Lang = 'en' | 'es';

export function normalizeLang(value: string | null | undefined): Lang {
  return String(value ?? '').toLowerCase().startsWith('es') ? 'es' : 'en';
}

const STRINGS = {
  en: {
    company: 'Lippolis Electric',
    product: 'Purchasing Control Center',
    email: 'Company email',
    password: 'Password',
    signIn: 'Sign in',
    signingIn: 'Signing in…',
    forgot: 'Forgot your password?',
    noAccount: 'No account yet?',
    noAccountBody: 'Accounts are created by the office. Ask them to invite your company email address.',
    switchTo: 'Español',
    switchLabel: 'Cambiar a español',
    signedOut: 'You have been signed out.',
    disabled: 'This account has been disabled. Contact the office.',
  },
  es: {
    company: 'Lippolis Electric',
    product: 'Centro de Control de Compras',
    email: 'Correo de la empresa',
    password: 'Contraseña',
    signIn: 'Entrar',
    signingIn: 'Entrando…',
    forgot: '¿Olvidó su contraseña?',
    noAccount: '¿Todavía no tiene cuenta?',
    noAccountBody: 'La oficina crea las cuentas. Pídales que inviten el correo de su empresa.',
    switchTo: 'English',
    switchLabel: 'Switch to English',
    signedOut: 'Su sesión ha terminado.',
    disabled: 'Esta cuenta está desactivada. Comuníquese con la oficina.',
  },
} as const;

// Every locale must carry every key — the type is the record of what a
// translation owes, and a missing string on the sign-in screen is somebody
// locked out.
export type LoginStrings = { readonly [K in keyof (typeof STRINGS)['en']]: string };

export function loginStrings(lang: Lang): LoginStrings {
  return STRINGS[lang];
}
