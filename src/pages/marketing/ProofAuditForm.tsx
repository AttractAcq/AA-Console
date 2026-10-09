import { useState } from "react";
import type { FormEvent } from "react";
import { ArrowRight, ArrowLeft, Check, Mail } from "lucide-react";
import { cn } from "../../lib/cn";
import { auditMailto } from "./auditBrief";
import type { AuditAnswers } from "./auditBrief";

/**
 * The on-page start of a proof audit.
 *
 * There is no public form endpoint, and inventing one that silently drops
 * submissions would be worse than not having a form. So this stays in the
 * browser and hands off to the visitor's own mail client at the end, with
 * the microcopy saying exactly that. It asks in two short steps rather
 * than one long form because the first question — what the business is —
 * is the one a stranger will answer.
 */

const STEPS = 2;

const EMPTY: AuditAnswers = { business: "", service: "", website: "", goal: "" };

const FIELD =
  "w-full rounded-lg border border-input bg-background px-3.5 py-2.5 text-[15px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card";
const LABEL = "mb-1.5 block text-sm font-medium text-foreground";

export function ProofAuditForm() {
  const [step, setStep] = useState(1);
  const [answers, setAnswers] = useState<AuditAnswers>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  const set = (key: keyof AuditAnswers) => (value: string) => {
    setAnswers((prev) => ({ ...prev, [key]: value }));
    setError(null);
  };

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step === 1) {
      // Only the business name is required to move on. Gating the second
      // step on every field is how a two-step form becomes a one-step form
      // with extra clicks.
      if (!answers.business.trim()) {
        setError("Tell us the name of the business so we know what we are auditing.");
        return;
      }
      setStep(2);
      return;
    }
    setStep(STEPS + 1);
  }

  const done = step > STEPS;

  return (
    <div className="rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-7">
      <div className="mb-5 flex items-baseline justify-between gap-3">
        <h3 className="text-base font-semibold tracking-[-0.012em] text-card-foreground">
          {done ? "Your audit request" : "Start a proof audit"}
        </h3>
        {!done && (
          <span className="shrink-0 text-xs font-medium text-muted-foreground">
            Step {step} of {STEPS}
          </span>
        )}
      </div>

      {done ? (
        <div className="space-y-5">
          <p className="flex items-start gap-2.5 text-[15px] text-foreground">
            <Check className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <span>
              That is everything we need to start. Sending opens your own mail
              app with the request already written.
            </span>
          </p>
          <a
            href={auditMailto(answers)}
            className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-6 py-3.5 text-[15px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          >
            <Mail className="h-4 w-4" aria-hidden="true" />
            Send to AA
          </a>
          <button
            type="button"
            onClick={() => setStep(1)}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Change an answer
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {step === 1 ? (
            <>
              <div>
                <label htmlFor="audit-business" className={LABEL}>
                  Business name
                </label>
                <input
                  id="audit-business"
                  className={FIELD}
                  value={answers.business}
                  onChange={(e) => set("business")(e.target.value)}
                  placeholder="Northside Dental"
                  autoComplete="organization"
                />
              </div>
              <div>
                <label htmlFor="audit-service" className={LABEL}>
                  Main service you want more of
                </label>
                <input
                  id="audit-service"
                  className={FIELD}
                  value={answers.service}
                  onChange={(e) => set("service")(e.target.value)}
                  placeholder="Dental implants"
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <label htmlFor="audit-website" className={LABEL}>
                  Website
                </label>
                <input
                  id="audit-website"
                  className={FIELD}
                  value={answers.website}
                  onChange={(e) => set("website")(e.target.value)}
                  placeholder="northsidedental.com"
                  autoComplete="url"
                />
              </div>
              <div>
                <label htmlFor="audit-goal" className={LABEL}>
                  What is not working right now?
                </label>
                <textarea
                  id="audit-goal"
                  rows={3}
                  className={cn(FIELD, "resize-y")}
                  value={answers.goal}
                  onChange={(e) => set("goal")(e.target.value)}
                  placeholder="We get enquiries but they go cold, and our content never mentions results."
                />
              </div>
            </>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex items-center gap-3 pt-1">
            {step === 2 && (
              <button
                type="button"
                onClick={() => setStep(1)}
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Back
              </button>
            )}
            <button
              type="submit"
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-primary px-6 py-3.5 text-[15px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              {step === 1 ? "Next" : "Review request"}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </form>
      )}

      <p className="mt-5 text-sm text-muted-foreground">
        A proof audit is free and takes about 30 minutes. We tell you what
        proof you already have, what it is worth, and what is missing —
        whether or not you work with us.
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        Nothing is submitted from this page. Your answers stay in this browser
        until you choose to send them.
      </p>
    </div>
  );
}
