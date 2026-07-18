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
}

/** Every Pro (write/refactor) tool, mapped to the capability it belongs to. */
const TOOL_FEATURE: Record<string, string> = {
  plan_rename_method: 'Propagated rename',
  plan_rename_entity: 'Propagated rename',
  plan_move: 'Move / extract',
  plan_move_entities: 'Move / extract',
  create_plugin: 'Plugin scaffold',
  extract_to_plugin: 'Extract to plugin',
  plan_change_relation: 'Schema edits',
  plan_rename_attribute: 'Schema edits',
  change_relation: 'Schema edits', // deprecated alias of plan_change_relation
  rename_attribute: 'Schema edits', // deprecated alias of plan_rename_attribute
  apply_edits: 'Safe apply',
  apply_rename: 'Safe apply',
};

/** Is this MCP tool gated behind a Pro license? */
export function isProTool(tool: string): boolean {
  return tool in TOOL_FEATURE;
}

/** The names of every gated tool (read tools are never here). */
export function proToolNames(): string[] {
  return Object.keys(TOOL_FEATURE);
}

/** Build the "Pro required" upsell for a gated tool. */
export function proRequired(tool: string): ProUpsell {
  const feature = TOOL_FEATURE[tool] ?? 'This refactor';
  return {
    proRequired: true,
    feature,
    tool,
    message: `${feature} is a DevKit for Strapi Pro feature — reading and analysing your project stays free, changing it is Pro.`,
    getPro: GET_PRO_URL,
    activate: ACTIVATE_HINT,
  };
}
