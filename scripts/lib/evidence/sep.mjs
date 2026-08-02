// ---------------------------------------------------------------------------
// sep.mjs — the field separator used in `git --format` templates.
//
// Git's own output is whitespace-separated, which is useless for parsing values
// that legitimately contain spaces (commit subjects, branch names with slashes,
// author names). So the collectors ask git for an explicit delimiter instead.
//
// It lives in its own module for one reason: written inline it is an invisible
// control character in the source, and an invisible literal is a bug waiting for
// a copy-paste. Here it is a named escape that reads as what it is.
// ---------------------------------------------------------------------------

export const SEP = String.fromCharCode(0x1f); // ASCII unit separator
