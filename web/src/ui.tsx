import { Check } from "@phosphor-icons/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useRef } from "react";
import { useIsOperator } from "./viewer";

const BUTTON = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  outline: "border border-border-strong bg-transparent hover:bg-accent",
  ghost: "bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
};

/** A text field, matching the buttons' height and shape. */
export const input =
  "h-11 min-w-0 rounded-full border border-border-strong bg-transparent px-4 text-sm placeholder:text-muted-foreground focus-visible:outline-2";

export function Button({
  variant = "default",
  size = "default",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BUTTON; size?: "sm" | "default" }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap transition-colors focus-visible:outline-2 disabled:pointer-events-none disabled:opacity-50 ${size === "sm" ? "h-9 px-4 text-sm" : "h-11 px-5"} ${BUTTON[variant]} ${className}`}
      {...props}
    />
  );
}

const TONE = {
  neutral: "bg-muted text-muted-foreground",
  success: "bg-success-muted text-success-muted-foreground",
  warning: "bg-warning-muted text-warning-muted-foreground",
  info: "bg-info-muted text-info-muted-foreground",
  destructive: "bg-destructive-muted text-destructive-muted-foreground",
};
export type Tone = keyof typeof TONE;

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex h-6 items-center gap-1 rounded-full whitespace-nowrap px-2.5 text-xs font-medium ${TONE[tone]}`}>
      {children}
    </span>
  );
}

/** Settled operation statuses, mapped once so every list reads them the same way. */
export const statusTone = (status: string | undefined): Tone =>
  status === "SUCCESS"
    ? "success"
    : status === "FAILED" || status === "REFUNDED"
      ? "destructive"
      : status
        ? "warning"
        : "neutral";

export function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold">{title}</h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`flex flex-col gap-5 rounded-2xl border bg-card p-6 ${className}`}>{children}</div>;
}

export function Spinner() {
  return <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}

/**
 * A mainnet action is always one deliberate click away: confirm, then run. Behind the hosted gateway
 * only operators may run one, unless it is an owner action, which for a DAO only files a proposal.
 */
export function ConfirmButton({
  label,
  title,
  description,
  confirm,
  onConfirm,
  disabled,
  ownerAction = false,
}: {
  label: ReactNode;
  title: string;
  description: string;
  confirm: string;
  onConfirm: () => void;
  disabled?: boolean;
  ownerAction?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const allowed = useIsOperator() || ownerAction;
  return (
    <>
      <Button disabled={disabled || !allowed} title={allowed ? undefined : "Operators only"} onClick={() => dialog.current?.showModal()}>
        {label}
      </Button>
      {/* Native modal: focus trap, Escape and backdrop come with the element. */}
      <dialog
        ref={dialog}
        onClick={(e) => e.target === dialog.current && dialog.current.close()}
        className="m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl border bg-card p-6 text-foreground shadow-xl backdrop:bg-black/40 backdrop:backdrop-blur-xs"
      >
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <h3 className="text-lg font-medium">{title}</h3>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => dialog.current?.close()}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                dialog.current?.close();
                onConfirm();
              }}
            >
              {confirm}
            </Button>
          </div>
        </div>
      </dialog>
    </>
  );
}

/**
 * One step of a numbered flow: the current step shows its body, a finished one collapses to a
 * checked row with a one-line summary.
 */
export function Step({
  number,
  title,
  status,
  summary,
  last,
  children,
}: {
  number: number;
  title: string;
  status: "complete" | "current" | "upcoming";
  summary?: ReactNode;
  last?: boolean;
  children?: ReactNode;
}) {
  return (
    <li className="relative flex gap-4 pb-8 last:pb-0">
      {!last && <span className="absolute top-9 bottom-1 left-4 w-px bg-border" />}
      <span
        className={`grid size-8 shrink-0 place-items-center rounded-full text-sm font-medium ${
          status === "complete"
            ? "bg-success-muted text-success-muted-foreground"
            : status === "current"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground"
        }`}
      >
        {status === "complete" ? <Check size={16} weight="bold" /> : number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3 pt-1">
        <div className="flex flex-col gap-0.5">
          <h3 className={`text-lg font-medium ${status === "upcoming" ? "text-muted-foreground" : ""}`}>{title}</h3>
          {status === "complete" && summary && <p className="truncate text-sm text-muted-foreground">{summary}</p>}
        </div>
        {status === "current" && children}
      </div>
    </li>
  );
}
