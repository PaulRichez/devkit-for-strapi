// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Hosted on a free subdomain of the existing paulrichez.fr (no new domain to buy).
const SITE = 'https://devkit-for-strapi.paulrichez.fr';

/**
 * Open external links in a new tab (build-time, for the markdown docs). The
 * hand-built Astro pages (index/success) do the same via a tiny inline script.
 */
function rehypeExternalLinks() {
  /** @param {unknown} href */
  const isExternal = (href) =>
    typeof href === 'string' && /^https?:\/\//i.test(href) && !href.includes('paulrichez.fr');
  /** @param {any} node */
  const walk = (node) => {
    if (node.type === 'element' && node.tagName === 'a' && isExternal(node.properties?.href)) {
      node.properties.target = '_blank';
      node.properties.rel = ['noopener', 'noreferrer'];
    }
    for (const child of node.children ?? []) walk(child);
  };
  /** @param {any} tree */
  return (tree) => walk(tree);
}

// https://astro.build/config
export default defineConfig({
  site: SITE,
  markdown: { rehypePlugins: [rehypeExternalLinks] },
  integrations: [
    starlight({
      title: 'DevKit for Strapi',
      description:
        'Accurate, project-aware tooling for Strapi magic strings — for your editor and your AI agent. Where Copilot guesses, DevKit knows.',
      favicon: '/favicon.svg',
      // Load the same type as the landing (Inter body + Sora display) so the docs
      // feel like the same product, not a separate gray theme.
      head: [
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true } },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Sora:wght@600;700;800&display=swap',
          },
        },
      ],
      customCss: ['./src/styles/theme.css'],
      lastUpdated: true,
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Installation', link: '/getting-started/' },
            { label: 'Configuration', link: '/configuration/' },
            { label: 'Magic strings', link: '/concepts/' },
          ],
        },
        {
          label: 'Features',
          items: [
            { label: 'In your editor', link: '/editor/' },
            { label: 'For your AI agent (MCP)', link: '/mcp/' },
            { label: 'MCP tool reference', link: '/mcp-tools/' },
            { label: 'Pro', link: '/pro/' },
          ],
        },
        { label: 'FAQ', link: '/faq/' },
      ],
    }),
  ],
});
