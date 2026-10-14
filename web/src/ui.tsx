import { Check, Copy } from "@phosphor-icons/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { ASSET_COLOR } from "./lib";
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
}: ButtonHTMLAttributes<HTMLButtonElement> & { ref?: React.Ref<HTMLButtonElement>; variant?: keyof typeof BUTTON; size?: "sm" | "default" }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap transition-colors focus-visible:outline-2 disabled:pointer-events-none disabled:opacity-50 ${size === "sm" ? "min-h-11 px-4 text-sm" : "h-11 px-5"} ${BUTTON[variant]} ${className}`}
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
  permitted,
  reviewKey,
}: {
  label: ReactNode;
  title: string;
  description: string;
  confirm: string;
  onConfirm: () => void;
  /** Bind this confirmation to a reviewed version; changes require reopening it. */
  reviewKey?: string;
  disabled?: boolean;
  ownerAction?: boolean;
  /** Explicit access to the target agent for cross-agent actions. UI only; the gateway enforces it. */
  permitted?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const operator = useIsOperator();
  const allowed = permitted ?? (operator || ownerAction);
  const titleId = useId();
  const descriptionId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [review, setReview] = useState<{ key: string; title: string; description: string; confirm: () => void }>();
  const [invalidated, setInvalidated] = useState(false);
  const changed = Boolean(review && (review.key !== reviewKey || disabled || !allowed));
  const invalidReview = invalidated || changed;
  useEffect(() => {
    if (changed) setInvalidated(true);
  }, [changed]);
  return (
    <>
      <Button ref={trigger} disabled={disabled || !allowed} title={allowed ? undefined : "Operators only"} onClick={() => {
        setInvalidated(false);
        setReview(reviewKey === undefined ? undefined : { key: reviewKey, title, description, confirm: onConfirm });
        dialog.current?.showModal();
      }}>
        {label}
      </Button>
      {/* Native modal: focus trap, Escape and backdrop come with the element. */}
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClose={() => {
          setReview(undefined);
          setInvalidated(false);
          if (trigger.current?.disabled) document.getElementById("agent-main")?.focus();
          else trigger.current?.focus();
        }}
        onClick={(e) => e.target === dialog.current && dialog.current.close()}
        className="m-auto max-h-[90dvh] overflow-y-auto overscroll-contain w-[calc(100%-2rem)] max-w-md rounded-3xl border bg-card p-6 text-foreground shadow-xl backdrop:bg-black/40 backdrop:backdrop-blur-xs"
      >
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <h3 id={titleId} className="text-lg font-medium">{review?.title ?? title}</h3>
            <p id={descriptionId} className="text-sm text-muted-foreground">{review?.description ?? description}</p>
            {invalidReview && <p role="alert" className="text-sm">This review is no longer current. Cancel and review the action again.</p>}
          </div>
          <div className="flex justify-end gap-3">
            <Button autoFocus variant="ghost" onClick={() => dialog.current?.close()}>
              Cancel
            </Button>
            <Button
              disabled={disabled || !allowed || invalidReview}
              onClick={() => {
                if (disabled || !allowed || invalidReview) return;
                dialog.current?.close();
                (review?.confirm ?? onConfirm)();
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
          {status === "complete" && summary && <p className="text-sm text-pretty break-words text-muted-foreground">{summary}</p>}
        </div>
        {status === "current" && children}
      </div>
    </li>
  );
}

/** Why an action failed, in the server's or wallet's words; nothing when it didn't. */
export function ErrorBox({ error }: { error?: string }) {
  return <div role="alert" aria-atomic="true" className={error ? undefined : "sr-only"}>{error && <p className="rounded-xl bg-destructive-muted px-4 py-3 text-sm text-destructive-muted-foreground">{error}</p>}</div>;
}

/** A query still on its way: what is loading, so an empty list is never shown in its place. */
export function Loading({ label }: { label: string }) {
  return (
    <p role="status" className="flex items-center gap-3 text-sm text-muted-foreground">
      <Spinner /> {label}
    </p>
  );
}

/** A query that failed: the server's words, and a retry, so a failure never reads as "nothing here". */
export function QueryError({ error, retry }: { error: { message: string }; retry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-destructive-muted px-4 py-3 text-sm text-destructive-muted-foreground">
      <span>{error.message}</span>
      <Button variant="ghost" size="sm" onClick={retry}>
        Check again
      </Button>
    </div>
  );
}

/** An operation's settled status, with the provider's failure code when it has one. */
export function StatusBadge({ status, failureCode, children }: { status: string; failureCode?: string | null; children?: ReactNode }) {
  return (
    <Badge tone={statusTone(status)}>
      {children}
      {status.toLowerCase()}
      {failureCode ? ` · ${failureCode}` : ""}
    </Badge>
  );
}

/** A rejection can occur after earlier actions; never infer non-execution from it. */
export function NotExecuted({ problems, again }: { problems: string[]; again: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-warning-muted px-4 py-3 text-sm text-warning-muted-foreground">
      <span className="font-medium">Execution stopped. Earlier actions may have completed. Review Activity before creating a new {again.toLowerCase()}.</span>
      {problems.map((p) => (
        <span key={p}>– {p}</span>
      ))}
    </div>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; message: string }>();
  const message = result?.text === text ? result.message : "";
  const copy = async () => {
    setBusy(true);
    setResult(undefined);
    try {
      await navigator.clipboard.writeText(text);
      setResult({ text, message: "Copied." });
    } catch {
      setResult({ text, message: "Could not copy. Try again or copy the displayed text." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-2">
      <Button variant="ghost" size="sm" disabled={busy} onClick={copy}>
        <Copy size={16} aria-hidden="true" /> {busy ? "Copying…" : "Copy"}
      </Button>
      <span role="status" aria-atomic="true" className={message ? "text-sm text-muted-foreground" : "sr-only"}>{message}</span>
    </span>
  );
}

/** Detail most readers skip, such as identifiers and rare controls, folded under a one-line summary. */
export function Details({ summary, open, className = "", children }: { summary: string; open?: boolean; className?: string; children: ReactNode }) {
  return (
    <details open={open} className={`text-sm ${className}`}>
      <summary className="cursor-pointer text-muted-foreground">{summary}</summary>
      <div className="mt-2 flex flex-col gap-2">{children}</div>
    </details>
  );
}

/** A card's heading: its icon, title and what it does. */
export function CardHeader({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <div className="flex gap-4">
      <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-muted text-brand-strong">{icon}</div>
      <div className="flex flex-col gap-1">
        <h3 className="text-lg font-medium">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

/** Fills a card's body when there is nothing to list yet. */
export function Empty({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
      {icon}
      {children}
    </div>
  );
}

/** An asset's chart colour, as a dot beside its name. */
export const Dot = ({ symbol }: { symbol: string }) => <span className={`size-2 rounded-full ${ASSET_COLOR[symbol] ?? "bg-muted-foreground"}`} />;
