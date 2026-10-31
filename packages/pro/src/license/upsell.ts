/**
 * The "Pro required" response a gated MCP tool returns when called without a
 * license. A normal (non-error) structured result the agent can relay to the
 * user — the feature, where to buy, and how to activate — rather than failing
 * silently or hard-erroring. Pure data; the MCP server returns it in place of
 * running a `plan_*`/`apply_*` tool when `isPro` is false. Both the refactor
 * *plan* and its *apply* are gated, so an agent can't sidestep the licence by
 * applying a free plan with its own edit tools.
 */

/** Where to buy a license — the public Pro page. */
export const GET_PRO_URL = 'https://devkit-for-strapi.paulrichez.fr/pro/';

/** How to activate, once bought — both surfaces. */
export const ACTIVATE_HINT =
  'Set DEVKIT_LICENSE_KEY in this MCP server\'s env, or run "DevKit for Strapi: Enter License Key" in your editor.';

/** The upsell payload returned in place of a gated tool's result. */
export interface ProUpsell {
  proRequired: true;
  /** Human label of the gated capability (e.g. "Propagated rename"). */
  feature: string;
  /** The tool that was called. */
  tool: string;
  message: string;
  getPro: string;
  activate: string;
  /** The offer running today (Black Friday), only while it runs. */
  offer?: string;
}

/** A limited-time price on Pro, mentioned only while it runs. */
export interface Offer {
  /** Stable id, so an editor shows its notice once. */
  id: string;
  text: string;
}

/**
 * Black Friday 2026: Polar's discount on Pro, which the Pro page's checkout link
 * applies, runs from 27 Nov 00:00 to 30 Nov 23:59, Paris time. Outside it the
 * price is the regular one, so the offer is never mentioned there.
 */
const OFFERS: { start: number; end: number; offer: Offer }[] = [
  {
    start: Date.parse('2026-11-26T23:00:00Z'),
    end: Date.parse('2026-11-30T23:00:00Z'),
    offer: { id: 'black-friday-2026', text: 'Black Friday: DevKit for Strapi Pro is €14.90 instead of €39.99 until November 30.' },
  },
];

/** The offer running at `now`, if any — a clock check, no network call. */
export function currentOffer(now: number = Date.now()): Offer | undefined {
  return OFFERS.find((o) => now >= o.start && now < o.end)?.offer;
}

/** Every Pro tool (writes, refactors, the data-model diagram), mapped to the capability it belongs to. */
const TOOL_FEATURE: Record<string, string> = {
  plan_rename_method: 'Propagated rename',
  plan_rename_entity: 'Propagated rename',
  plan_move: 'Move / extract',
  plan_move_entities: 'Move / extract',
  create_plugin: 'Plugin scaffold',
  extract_to_plugin: 'Extract to plugin',
  plan_change_relation: 'Schema edits',
  plan_rename_attribute: 'Schema edits',
  apply_edits: 'Safe apply',
  apply_rename: 'Safe apply',
  get_model_diagram: 'Relations diagram',
  config_sync_diff: 'Config sync',
  config_sync_export: 'Config sync',
  config_sync_import: 'Config sync',
};

/** Is this MCP tool gated behind a Pro license? */
export function isProTool(tool: string): boolean {
  return tool in TOOL_FEATURE;
}

/** The names of every gated tool (the read tools are free, except the diagram). */
export function proToolNames(): string[] {
  return Object.keys(TOOL_FEATURE);
}

/** Build the "Pro required" upsell for a gated tool. */
export function proRequired(tool: string, now: number = Date.now()): ProUpsell {
  const feature = TOOL_FEATURE[tool] ?? 'This refactor';
  const offer = currentOffer(now);
  return {
    proRequired: true,
    feature,
    tool,
    message: `${feature} is a DevKit for Strapi Pro feature — reading and analysing your project stays free, changing it is Pro.`,
    getPro: GET_PRO_URL,
    activate: ACTIVATE_HINT,
    ...(offer ? { offer: offer.text } : {}),
  };
}
