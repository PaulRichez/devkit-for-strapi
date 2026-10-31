/**
 * Where a visit comes from, carried to Polar's checkout: its links take `utm_*`
 * parameters and keep them in the checkout session's metadata, so a sale can be
 * traced to the editor's notice, a README or a search engine. The tags the visitor
 * arrived with (`utm_*` in the URL, else the referring site's host) are kept for the
 * tab's session (sessionStorage: no cookie, gone when the tab closes); without any,
 * the link says the site sent it. `utm_content` names the button (its Umami `cta`).
 */
export const ATTRIBUTION_SCRIPT = `(() => {
  const KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  let from = {};
  try {
    const q = new URLSearchParams(location.search);
    for (const k of KEYS) if (q.get(k)) from[k] = q.get(k);
    const ref = document.referrer ? new URL(document.referrer).hostname : '';
    if (!Object.keys(from).length && ref && ref !== location.hostname) from = { utm_source: ref, utm_medium: 'referral' };
    if (Object.keys(from).length) sessionStorage.setItem('devkit-utm', JSON.stringify(from));
    else from = JSON.parse(sessionStorage.getItem('devkit-utm') || '{}');
  } catch {}
  const run = () => {
    for (const a of document.querySelectorAll('a[href^="https://buy.polar.sh/"]')) {
      const url = new URL(a.href);
      const tags = { utm_source: 'site', utm_medium: location.pathname.split('/').filter(Boolean).join('/') || 'home', ...from };
      if (a.dataset.umamiEventCta) tags.utm_content = a.dataset.umamiEventCta;
      for (const [k, v] of Object.entries(tags)) url.searchParams.set(k, v);
      a.href = url.toString();
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();`;
