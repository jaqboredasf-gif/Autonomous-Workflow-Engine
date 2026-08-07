'use client';
// Evidence upload.
//
// A styled shell around a real <input type="file">, not a replacement for it:
// the file rides to the server action in the ordinary FormData, so the control
// works without JavaScript and a phone's camera is one tap away
// (capture="environment" on the photo variant).
//
// The client part is only the list of what has been chosen — a person
// photographing a damaged pallet on a job site needs to see that the photo
// took, before they hit Confirm.
import { useRef, useState } from 'react';

import { buttonStyle } from './Button';

export function FileUpload({
  name,
  label,
  hint,
  accept,
  capture,
  multiple = true,
  maxFiles = 6,
  size = 'm',
}: {
  name: string;
  label: string;
  hint?: string;
  accept?: string;
  capture?: 'environment' | 'user';
  multiple?: boolean;
  maxFiles?: number;
  size?: 'm' | 'l';
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<Array<{ name: string; size: number }>>([]);
  const [tooMany, setTooMany] = useState(false);

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        name={name}
        accept={accept}
        capture={capture}
        multiple={multiple}
        className="sr-only"
        onChange={(event) => {
          const chosen = Array.from(event.target.files ?? []);
          setTooMany(chosen.length > maxFiles);
          setFiles(chosen.slice(0, maxFiles).map((f) => ({ name: f.name, size: f.size })));
        }}
      />
      <button type="button" onClick={() => inputRef.current?.click()} className={buttonStyle('secondary', size)}>
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M10 4v12M4 10h12" strokeLinecap="round" />
        </svg>
        {label}
      </button>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}

      {files.length ? (
        <ul className="mt-2 space-y-1" aria-live="polite">
          {files.map((f) => (
            <li key={f.name} className="flex items-center justify-between gap-2 rounded-md bg-subtle px-3 py-2 text-xs text-ink-soft">
              <span className="truncate">{f.name}</span>
              <span className="shrink-0 tabular-nums text-muted">{Math.max(1, Math.round(f.size / 1024))} KB</span>
            </li>
          ))}
        </ul>
      ) : null}

      {tooMany ? (
        <p role="alert" className="mt-1 text-xs font-medium text-danger">
          Only the first {maxFiles} files are kept. Record the rest on a second receipt.
        </p>
      ) : null}
    </div>
  );
}

/** The photo variant: opens the camera directly on a phone. */
export function PhotoUpload(props: Omit<Parameters<typeof FileUpload>[0], 'accept' | 'capture'>) {
  return <FileUpload {...props} accept="image/*" capture="environment" />;
}
