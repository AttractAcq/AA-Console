import { Link } from "react-router-dom";
import { ArrowRight, Check, CircleDot, FolderCheck } from "lucide-react";
import { cn } from "../../lib/cn";
import { ProofAuditForm } from "./ProofAuditForm";
import {
  AUDIENCES,
  CONSOLE_SAMPLE,
  DELIVERABLES,
  FAQ,
  FOOTER_LINKS,
  HERO,
  HERO_ASSURANCES,
  POSITIONING,
  PREMISE,
  PROOF_EXAMPLE,
  STEPS,
} from "./landingContent";

/**
 * AA's public landing page.
 *
 * It is a standalone page, deliberately outside AppShell and the role
 * gates: the whole point is that a stranger can read it. It uses the
 * console's own tokens (`--primary`, `--border`, `--card`, Inter) rather
 * than a separate marketing palette, so the page a prospect sees and the
 * console they are handed after signing are visibly the same product.
 */

const SHELL = "mx-auto w-full max-w-6xl px-5 sm:px-8";

/** The brand underline under the accent word. Drawn, not a border, so it
 *  keeps the slight hand-made slant at every width. */
function Underline() {
  return (
    <svg
      className="absolute -bottom-[0.14em] left-0 h-[0.2em] w-full text-primary/45"
      viewBox="0 0 300 12"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        d="M2 8.5C52 3.2 150 2 298 5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Eyebrow({ children }: { children: string }) {
  return (
    <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-brand-strong">
      <CircleDot className="h-3.5 w-3.5" aria-hidden="true" />
      {children}
    </p>
  );
}

function PrimaryCta({ label, className }: { label: string; className?: string }) {
  return (
    <a
      href="#start"
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-full bg-primary px-7 py-4 text-base font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
    >
      {label}
      <ArrowRight className="h-4 w-4" aria-hidden="true" />
    </a>
  );
}

function Nav() {
  return (
    <div className="sticky top-3 z-50 px-3 sm:top-5 sm:px-5">
      <nav
        aria-label="Main"
        className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 rounded-full border border-border/70 bg-card/85 py-2.5 pl-3 pr-2.5 shadow-sm backdrop-blur-md"
      >
        <a href="#top" className="flex items-center gap-2.5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-[13px] font-bold tracking-[0.02em] text-primary-foreground"
          >
            AA
          </span>
          <span className="hidden text-[15px] font-semibold tracking-[-0.012em] text-foreground sm:inline">
            Attract Acquisition
          </span>
        </a>

        <div className="flex items-center gap-1">
          <div className="hidden items-center gap-1 md:flex">
            {[
              { href: "#how", label: "How it works" },
              { href: "#proof", label: "Proof Bank" },
              { href: "#faq", label: "FAQ" },
            ].map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="rounded-full px-3 py-2 text-sm font-medium text-ink-subtle transition-colors hover:bg-accent hover:text-foreground"
              >
                {item.label}
              </a>
            ))}
          </div>
          <a
            href="#start"
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          >
            <span className="sm:hidden">Proof audit</span>
            <span className="hidden sm:inline">Book a proof audit</span>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </div>
      </nav>
    </div>
  );
}

function Hero() {
  return (
    <header
      id="top"
      className="relative -mt-[4.5rem] overflow-hidden pb-16 pt-[8.5rem] sm:pb-24 sm:pt-[10.5rem]"
      style={{
        background: [
          "radial-gradient(90% 60% at 18% 0%, color-mix(in oklab, var(--primary) 16%, transparent), transparent 70%)",
          "radial-gradient(70% 55% at 92% 8%, color-mix(in oklab, var(--primary) 9%, transparent), transparent 72%)",
          "linear-gradient(to bottom, var(--cool-surface), var(--background))",
        ].join(","),
      }}
    >
      <div className={SHELL}>
        <Eyebrow>{HERO.eyebrow}</Eyebrow>

        <h1 className="mt-5 max-w-3xl text-[2.75rem] font-bold leading-[1.02] tracking-[-0.032em] text-foreground sm:text-6xl lg:text-[4.25rem]">
          {HERO.headlineLead}{" "}
          <span className="relative inline-block whitespace-nowrap">
            {HERO.headlineAccent}
            <Underline />
          </span>
        </h1>

        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-subtle sm:text-xl">
          {HERO.subhead}
        </p>

        <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
          <PrimaryCta label={HERO.primaryCta} className="w-full sm:w-auto" />
          <a
            href="#how"
            className="inline-flex w-full items-center justify-center rounded-full border border-border bg-card px-7 py-4 text-base font-semibold text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:w-auto"
          >
            <span className="underline underline-offset-4">{HERO.secondaryCta}</span>
          </a>
        </div>

        <ul className="mt-9 flex flex-wrap gap-x-7 gap-y-3">
          {HERO_ASSURANCES.map((item) => (
            <li key={item} className="flex items-center gap-2 text-[15px] font-medium text-foreground">
              <span className="flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] border-primary/70">
                <Check className="h-3 w-3 text-primary" aria-hidden="true" />
              </span>
              {item}
            </li>
          ))}
        </ul>
      </div>
    </header>
  );
}

/**
 * The console, shown rather than described — and shown as a sample, which
 * the chrome says out loud. A mocked screenshot that reads as a client
 * result would be exactly the unsourced claim this page argues against.
 */
function ConsoleView() {
  return (
    <section className={cn(SHELL, "pb-20 sm:pb-28")} aria-labelledby="console-heading">
      <div className="overflow-hidden rounded-3xl border border-border bg-cool-surface">
        <div className="grid gap-10 p-6 sm:p-10 lg:grid-cols-[1fr_minmax(0,22rem)] lg:items-center lg:gap-14">
          <div>
            <Eyebrow>Live console view</Eyebrow>
            <h2
              id="console-heading"
              className="mt-4 max-w-md text-3xl font-bold leading-[1.1] tracking-[-0.024em] text-foreground sm:text-4xl"
            >
              The work is already sorted. You decide.
            </h2>
            <p className="mt-4 max-w-md text-[17px] leading-relaxed text-ink-subtle">
              Your console opens on one short list: what AA did overnight, and
              the handful of things that genuinely need a person. No dashboard
              to interpret, no folder to go hunting through.
            </p>

            <dl className="mt-8 grid max-w-md grid-cols-3 gap-4 border-t border-border pt-6">
              {CONSOLE_SAMPLE.stats.map((stat) => (
                <div key={stat.label}>
                  <dt className="sr-only">{stat.label}</dt>
                  <dd>
                    <span className="block text-xl font-bold tracking-[-0.02em] text-foreground sm:text-2xl">
                      {stat.value}
                    </span>
                    <span className="mt-1 block text-[13px] leading-snug text-muted-foreground">
                      {stat.label}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="mx-auto w-full max-w-[22rem]">
            <div className="rounded-[2rem] border border-border bg-card p-3 shadow-lg">
              <div className="rounded-[1.5rem] bg-background p-5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-[10px] font-bold text-primary-foreground"
                    >
                      AA
                    </span>
                    <span className="whitespace-nowrap text-sm font-semibold text-foreground">
                      AA Console
                    </span>
                  </div>
                  <span className="whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                    Sample workspace
                  </span>
                </div>

                <p className="mt-6 text-2xl font-bold leading-tight tracking-[-0.024em] text-foreground">
                  {CONSOLE_SAMPLE.greeting}
                </p>
                <p className="mt-2 text-[15px] leading-snug text-muted-foreground">
                  {CONSOLE_SAMPLE.summary}{" "}
                  <strong className="font-semibold text-foreground">
                    {CONSOLE_SAMPLE.summaryEmphasis}
                  </strong>
                </p>

                <p className="mt-7 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {CONSOLE_SAMPLE.queueLabel} · {CONSOLE_SAMPLE.queue.length}
                </p>
                <ul className="mt-3 space-y-2.5">
                  {CONSOLE_SAMPLE.queue.map((item) => (
                    <li key={item.title} className="rounded-xl border border-border bg-card p-3.5">
                      <p className="text-[14px] font-semibold leading-snug text-card-foreground">
                        {item.title}
                      </p>
                      <p className="mt-1 text-[12px] text-muted-foreground">{item.meta}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Premise() {
  return (
    <section className={cn(SHELL, "pb-20 sm:pb-28")} aria-labelledby="premise-heading">
      <Eyebrow>{PREMISE.eyebrow}</Eyebrow>
      <h2
        id="premise-heading"
        className="mt-4 max-w-2xl text-3xl font-bold leading-[1.08] tracking-[-0.026em] text-foreground sm:text-[2.75rem]"
      >
        {PREMISE.headline}
      </h2>
      <p className="mt-5 max-w-2xl text-[17px] leading-relaxed text-ink-subtle sm:text-lg">
        {PREMISE.body}
      </p>

      <div className="mt-12 grid gap-5 sm:grid-cols-3">
        {PREMISE.columns.map((col) => (
          <div key={col.title} className="rounded-2xl border border-border bg-card p-6">
            <h3 className="text-base font-semibold tracking-[-0.012em] text-card-foreground">
              {col.title}
            </h3>
            <p className="mt-2.5 text-[15px] leading-relaxed text-muted-foreground">{col.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/** The Proof Bank, shown as the record it actually files. */
function ProofSpotlight() {
  const rows = [
    { label: "Claim", value: PROOF_EXAMPLE.claim },
    { label: "Evidence", value: PROOF_EXAMPLE.evidence },
    { label: "Relevant to", value: PROOF_EXAMPLE.relevance },
    { label: "Strength", value: PROOF_EXAMPLE.strength },
  ];

  return (
    <section id="proof" className={cn(SHELL, "scroll-mt-28 pb-20 sm:pb-28")} aria-labelledby="proof-heading">
      <div className="grid gap-10 lg:grid-cols-2 lg:items-center lg:gap-16">
        <div>
          <Eyebrow>Proof Bank</Eyebrow>
          <h2
            id="proof-heading"
            className="mt-4 text-3xl font-bold leading-[1.08] tracking-[-0.026em] text-foreground sm:text-[2.5rem]"
          >
            No claim without a receipt.
          </h2>
          <p className="mt-5 text-[17px] leading-relaxed text-ink-subtle">
            Every piece of evidence is filed the same way: what it lets you
            claim, where it came from, who it speaks to, and whether you have
            cleared it for advertising. Finding a review is not permission to
            advertise with it, so nothing is cleared until you say so.
          </p>
          <p className="mt-4 text-[17px] leading-relaxed text-ink-subtle">
            The number that matters is not how much proof exists, it is how
            much an agent may actually cite — and the gap between them is a
            job someone can finish this afternoon.
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-7">
          <div className="flex items-center justify-between gap-3 border-b border-border pb-4">
            <div className="flex items-center gap-2.5">
              <FolderCheck className="h-4.5 w-4.5 text-primary" aria-hidden="true" />
              <span className="text-sm font-semibold text-card-foreground">
                {PROOF_EXAMPLE.type}
              </span>
            </div>
            <span className="font-mono text-xs text-muted-foreground">{PROOF_EXAMPLE.ref}</span>
          </div>

          <dl className="divide-y divide-border">
            {rows.map((row) => (
              <div key={row.label} className="grid grid-cols-[7rem_1fr] gap-3 py-3.5">
                <dt className="text-[13px] font-medium text-muted-foreground">{row.label}</dt>
                <dd className="text-[15px] leading-snug text-card-foreground">{row.value}</dd>
              </div>
            ))}
          </dl>

          <p className="mt-2 flex items-center gap-2 rounded-xl bg-accent px-3.5 py-3 text-sm font-semibold text-accent-foreground">
            <Check className="h-4 w-4 text-primary" aria-hidden="true" />
            {PROOF_EXAMPLE.rights}
          </p>
          <p className="mt-4 text-xs text-muted-foreground">
            Example record. Yours are built from proof your business has
            already published.
          </p>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section
      id="how"
      className="scroll-mt-28 border-y border-border bg-cool-surface py-20 sm:py-28"
      aria-labelledby="how-heading"
    >
      <div className={SHELL}>
        <Eyebrow>The machine</Eyebrow>
        <h2
          id="how-heading"
          className="mt-4 max-w-2xl text-3xl font-bold leading-[1.08] tracking-[-0.026em] text-foreground sm:text-[2.75rem]"
        >
          Eight stages, one system, nothing waiting on someone to remember it.
        </h2>
        <p className="mt-5 max-w-2xl text-[17px] leading-relaxed text-ink-subtle sm:text-lg">
          This is not a service menu — it is the pipeline your work actually
          moves through, in order. You can see every stage of it in your
          console.
        </p>

        <ol
          aria-label="The AA pipeline, in order"
          className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4"
        >
          {STEPS.map((step) => (
            <li key={step.n} className="bg-card p-6">
              <span className="font-mono text-xs font-semibold tracking-[0.08em] text-primary">
                {step.n}
              </span>
              <h3 className="mt-3 text-base font-semibold tracking-[-0.012em] text-card-foreground">
                {step.label}
              </h3>
              <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Deliverables() {
  return (
    <section className={cn(SHELL, "py-20 sm:py-28")} aria-labelledby="deliverables-heading">
      <Eyebrow>What you get</Eyebrow>
      <h2
        id="deliverables-heading"
        className="mt-4 max-w-2xl text-3xl font-bold leading-[1.08] tracking-[-0.026em] text-foreground sm:text-[2.5rem]"
      >
        One retainer, the whole engine.
      </h2>

      <ul className="mt-11 grid gap-x-10 gap-y-7 sm:grid-cols-2 lg:grid-cols-4">
        {DELIVERABLES.map((item) => (
          <li key={item.title}>
            <h3 className="flex items-start gap-2 text-[15px] font-semibold text-foreground">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              {item.title}
            </h3>
            <p className="mt-1.5 pl-6 text-[14px] leading-relaxed text-muted-foreground">
              {item.body}
            </p>
          </li>
        ))}
      </ul>

      <div className="mt-14 border-t border-border pt-8">
        <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Built for
        </h3>
        <ul className="mt-4 flex flex-wrap gap-2.5">
          {AUDIENCES.map((audience) => (
            <li
              key={audience}
              className="rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground"
            >
              {audience}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Faq() {
  return (
    <section
      id="faq"
      className="scroll-mt-28 border-t border-border bg-cool-surface py-20 sm:py-28"
      aria-labelledby="faq-heading"
    >
      <div className={cn(SHELL, "max-w-3xl")}>
        <Eyebrow>Straight answers</Eyebrow>
        <h2
          id="faq-heading"
          className="mt-4 text-3xl font-bold leading-[1.08] tracking-[-0.026em] text-foreground sm:text-[2.5rem]"
        >
          The questions worth asking first.
        </h2>

        <div className="mt-10 divide-y divide-border border-y border-border">
          {FAQ.map((item) => (
            <details key={item.q} className="group py-5">
              <summary className="flex cursor-pointer list-none items-start justify-between gap-5 text-[17px] font-semibold leading-snug tracking-[-0.012em] text-foreground marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {item.q}
                <span
                  aria-hidden="true"
                  className="mt-1 shrink-0 text-xl font-normal leading-none text-primary transition-transform group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <p className="mt-3 max-w-2xl pr-10 text-[15px] leading-relaxed text-ink-subtle">
                {item.a}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function StartSection() {
  return (
    <section id="start" className={cn(SHELL, "scroll-mt-28 py-20 sm:py-28")} aria-labelledby="start-heading">
      <div className="grid gap-10 lg:grid-cols-[1fr_minmax(0,26rem)] lg:items-start lg:gap-16">
        <div>
          <Eyebrow>Start here</Eyebrow>
          <h2
            id="start-heading"
            className="mt-4 text-3xl font-bold leading-[1.08] tracking-[-0.026em] text-foreground sm:text-[2.75rem]"
          >
            Find out what your proof is worth.
          </h2>
          <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-ink-subtle sm:text-lg">
            Before anyone talks about a retainer, we go and look. We sweep
            what your business has already published, file it the way the
            Proof Bank would, and show you the result: what you can claim
            today, what is strong enough to advertise, and where the gaps
            are.
          </p>
          <ul className="mt-8 space-y-3">
            {[
              "A filed proof bank for your business, yours to keep",
              "The angles your evidence already supports",
              "The three gaps worth collecting against first",
            ].map((item) => (
              <li key={item} className="flex items-start gap-2.5 text-[15px] text-foreground">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <ProofAuditForm />
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="px-3 pb-3 sm:px-5 sm:pb-5">
      <div className="relative overflow-hidden rounded-3xl bg-[oklch(0.17_0.035_257)] px-6 pb-10 pt-10 text-[oklch(0.985_0.003_248)] sm:px-10 sm:pb-12 sm:pt-12">
        <div className="relative z-10 mx-auto w-full max-w-6xl">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground"
            >
              AA
            </span>
            <span className="text-lg font-semibold tracking-[-0.012em]">Attract Acquisition</span>
          </div>

          <p className="mt-7 max-w-md text-[17px] leading-relaxed text-white/65">{POSITIONING}</p>

          <a
            href="#start"
            className="mt-7 inline-flex items-center gap-2 text-[15px] font-semibold underline underline-offset-4 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          >
            Book a proof audit
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </a>

          <div className="mt-10 border-t border-white/12 pt-7">
            <ul className="flex flex-wrap gap-x-8 gap-y-3">
              {FOOTER_LINKS.map((link) => (
                <li key={link.href}>
                  {link.href.startsWith("/") && !link.href.startsWith("//") ? (
                    <Link
                      to={link.href}
                      className="text-sm text-white/75 underline underline-offset-4 hover:text-white"
                    >
                      {link.label}
                    </Link>
                  ) : (
                    <a
                      href={link.href}
                      className="text-sm text-white/75 underline underline-offset-4 hover:text-white"
                    >
                      {link.label}
                    </a>
                  )}
                </li>
              ))}
            </ul>

            <p className="mt-9 text-sm text-white/45">© 2026 Attract Acquisition</p>
            <p className="mt-1.5 text-sm text-white/45">Built for service businesses.</p>
          </div>
        </div>

        {/* The wordmark bleeding off the bottom edge. Decorative, and large
            enough that it must not be read by a screen reader. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-6 left-4 select-none text-[22vw] font-bold leading-none tracking-[-0.04em] text-white/[0.045] sm:-bottom-10 sm:text-[15rem]"
        >
          AA
        </span>
      </div>
    </footer>
  );
}

export function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main>
        <Hero />
        <ConsoleView />
        <Premise />
        <ProofSpotlight />
        <HowItWorks />
        <Deliverables />
        <Faq />
        <StartSection />
      </main>
      <Footer />
    </div>
  );
}
