import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/**
 * Puts a page back at the top when you navigate to it.
 *
 * React Router does not reset scroll on navigation — that is left to the app,
 * and this app never did it. Reading a long Intelligence page and then opening
 * Media dropped you into the middle of the new page, which reads as a broken
 * layout rather than as retained scroll.
 *
 * The scroll lives on the shell's `<main>`, not on the document: the shells are
 * `h-screen overflow-hidden` with `overflow-y-auto` inside. So `window.scrollTo`
 * alone is a silent no-op here — the ref is the part that actually works. The
 * window reset is kept for the one case it does matter: a modal that scrolled
 * the document body while it was open.
 *
 * Keyed on search as well as pathname because `?tab=` is how this app switches
 * tabs, and a new tab is new content. It is the only search param in use, so
 * nothing filter-shaped gets yanked to the top mid-interaction.
 */
export function useScrollToTop<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const { pathname, search } = useLocation();

  useEffect(() => {
    const el = ref.current;
    if (el) {
      // Assigning scrollTop rather than calling scrollTo: it is universally
      // implemented (scrollTo is not — jsdom has no such method), it cannot be
      // hijacked by a `scroll-behavior: smooth` rule into animating what should
      // be an instant jump to a new page, and it needs no feature check.
      el.scrollTop = 0;
      el.scrollLeft = 0;
    }
    // The document only scrolls if a modal moved it while it was open.
    window.scrollTo?.(0, 0);
  }, [pathname, search]);

  return ref;
}
