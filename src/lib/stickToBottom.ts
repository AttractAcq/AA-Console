/**
 * Scroll a message list to its newest message, without moving the page.
 *
 * `endRef.current.scrollIntoView()` is the obvious way to write this and is
 * wrong here. scrollIntoView scrolls **every** scrollable ancestor of the
 * element, not just the nearest one — so a chat sitting halfway down a page
 * drags the whole page down with it as soon as its history loads. That is
 * exactly what happened on both dashboards: they were scrolled to the top
 * correctly by useScrollToTop, and then the Master AI chat pulled them back
 * down a moment later when its turns arrived.
 *
 * Assigning scrollTop on the list itself cannot reach past that element, so
 * the chat goes to its newest message and nothing above it moves. It also
 * matches the discipline in useScrollToTop: scrollTop is universally
 * implemented (jsdom has no scrollTo), needs no feature check, and cannot be
 * turned into an animation by a `scroll-behavior: smooth` rule.
 */
export function stickToBottom(el: HTMLElement | null): void {
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}
