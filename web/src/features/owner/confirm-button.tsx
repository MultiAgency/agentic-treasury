import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "../../shared/ui";
import { useIsOperator } from "../../app/viewer";

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
