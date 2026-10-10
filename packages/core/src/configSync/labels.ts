/** Readable names for config-sync keys ("Vue — Article" instead of `core-store.plugin_content_manager_configuration_content_types::api::article.article`). */

import type { StrapiProject } from '../model/types';

/** The core-store keys of the content-manager views (a content-type's, a component's). */
export const CM_CT_PREFIX = 'plugin_content_manager_configuration_content_types::';
export const CM_COMPONENT_PREFIX = 'plugin_content_manager_configuration_components::';

export type ConfigSyncGroup = 'views' | 'roles' | 'admin-roles' | 'locales' | 'settings' | 'custom';

export interface ConfigSyncLabel {
  label: string;
  group: ConfigSyncGroup;
  /** The UID it is about, for a view. */
  uid?: string;
}

const SETTINGS: Record<string, string> = {
  plugin_upload_settings: 'Upload settings',
  plugin_upload_view_configuration: 'Media library view',
  'plugin_users-permissions_advanced': 'Users & Permissions — advanced settings',
  'plugin_users-permissions_email': 'Users & Permissions — email templates',
  'plugin_users-permissions_grant': 'Users & Permissions — providers',
  plugin_i18n_default_locale: 'Default locale',
  core_admin_auth: 'Admin authentication settings',
};

const titleCase = (s: string): string => s.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** The label of `key` (`<type>.<name>`) in `project`. */
export function configSyncLabel(project: StrapiProject | undefined, type: string, name: string): ConfigSyncLabel {
  if (type === 'core-store') {
    for (const [prefix, kind] of [
      [CM_CT_PREFIX, 'type'],
      [CM_COMPONENT_PREFIX, 'component'],
    ] as const) {
      if (!name.startsWith(prefix)) continue;
      const uid = name.slice(prefix.length);
      const display =
        kind === 'type'
          ? (project?.index.contentTypes.get(uid)?.info.displayName ?? project?.index.codeContentTypes?.get(uid)?.info.displayName)
          : project?.index.components.get(uid)?.info.displayName;
      return { label: `View — ${display ?? uid}${kind === 'component' ? ' (component)' : ''}`, group: 'views', uid };
    }
    return { label: SETTINGS[name] ?? `Settings — ${name}`, group: 'settings' };
  }
  if (type === 'user-role') return { label: `Role ${titleCase(name)}`, group: 'roles' };
  if (type === 'admin-role') return { label: `Admin role ${titleCase(name.replace(/^strapi-/, ''))}`, group: 'admin-roles' };
  if (type === 'i18n-locale') return { label: `Locale ${name}`, group: 'locales' };
  return { label: `${type} ${name}`, group: 'custom' };
}
