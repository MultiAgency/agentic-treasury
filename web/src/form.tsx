import { useId, type InputHTMLAttributes } from "react";
import { input } from "./ui";

/** A persistent label and a field-local error, linked for keyboard and screen-reader use. */
export function Field({ label, error, className = "", ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string }) {
  const id = useId();
  return <div className={`flex min-w-0 flex-col gap-1 text-sm ${className}`}>
    <label htmlFor={id} className="text-muted-foreground">{label}</label>
    <input {...props} className={input} id={id} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : props["aria-describedby"]} />
    {error && <span id={`${id}-error`} className="text-destructive-muted-foreground">{error}</span>}
  </div>;
}

/** React commits field errors before focus is moved; don't steal focus while someone is typing. */
export function focusInvalid(form: HTMLFormElement) {
  requestAnimationFrame(() => form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
}
