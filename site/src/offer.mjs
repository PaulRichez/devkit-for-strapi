/**
 * Black Friday 2026 on the site — the same dates as Polar's discount and as
 * `packages/pro/src/license/upsell.ts`: 27 Nov 00:00 to 30 Nov 23:59, Paris time.
 * Elements marked `data-offer-show` appear only then, `data-offer-hide` ones
 * disappear. A clock check in the visitor's browser: the price itself is Polar's,
 * which applies the discount on the checkout link only between those dates.
 */
export const OFFER_SCRIPT = `(() => {
  const t = Date.now();
  if (t < Date.parse('2026-11-26T23:00:00Z') || t >= Date.parse('2026-11-30T23:00:00Z')) return;
  const run = () => {
    for (const e of document.querySelectorAll('[data-offer-show]')) e.hidden = false;
    for (const e of document.querySelectorAll('[data-offer-hide]')) e.hidden = true;
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();`;
