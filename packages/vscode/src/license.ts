import {
  isPro,
  resolveLicense,
  type CachedLicense,
  type LicenseCache,
  type LicenseValidation,
  type LicenseVerifier,
} from 'devkit-for-strapi-pro';
import * as vscode from 'vscode';

/**
 * Editor-side Pro licence: store the key in VS Code's SecretStorage (the OS
 * keychain — never settings.json), validate it against Polar (cached offline in
 * globalState), and gate the Pro features (rename). The pure decision logic
 * lives in `devkit-for-strapi-pro`; this is the boundary (SecretStorage + HTTP).
 */

const SECRET_KEY = 'strapiDevkit.licenseKey';
const CACHE_KEY = 'strapiDevkit.licenseCache';
const POLAR_API = 'https://api.polar.sh';

/** Our Polar organization id (public — identifies the seller org). */
const POLAR_ORG_ID = '6bb206eb-2492-4be2-b074-292f5468faa9';

/**
 * Online verifier against Polar's license-key endpoint. Mirrors
 * `packages/mcp/src/license.ts` — boundary code in two independent client
 * distributions; extract to pro (with an injected fetch) if a 3rd appears.
 */
function polarVerifier(organizationId: string): LicenseVerifier {
  return {
    async validate(key: string): Promise<LicenseValidation> {
      if (!organizationId) return { valid: false };
      const res = await fetch(`${POLAR_API}/v1/customer-portal/license-keys/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, organization_id: organizationId }),
      });
      if (res.status >= 400 && res.status < 500) return { valid: false }; // unknown/inactive key
      if (!res.ok) throw new Error(`Polar validate failed: ${res.status}`); // transient → offline fallback
      const body = (await res.json()) as { status?: string; expires_at?: string | null };
      const ms = body.expires_at ? Date.parse(body.expires_at) : NaN;
      return { valid: body.status === 'granted', expiresAt: Number.isNaN(ms) ? null : ms };
    },
  };
}

/** Editor-side licence manager: stores the key, resolves Pro, notifies on change. */
export interface LicenseManager {
  /** Whether Pro is unlocked. Memoizes a positive result; a negative one re-checks. */
  isLicensed(): Promise<boolean>;
  /** The stored key (SecretStorage) — forwarded into the bundled MCP server's env. */
  getKey(): Promise<string | undefined>;
  /** Prompt for a key and store it (empty input removes it). */
  enterKey(): Promise<void>;
  /** Remove the stored key. */
  clearKey(): Promise<void>;
  /** Fires when the key changes (so the MCP server is re-offered with the new env). */
  readonly onDidChange: vscode.Event<void>;
}

/** Build the licence manager for this extension activation. */
export function createLicenseManager(context: vscode.ExtensionContext): LicenseManager {
  const emitter = new vscode.EventEmitter<void>();
  context.subscriptions.push(emitter);
  let pending: Promise<boolean> | undefined;

  const cache: LicenseCache = {
    read: () => context.globalState.get<CachedLicense>(CACHE_KEY),
    write: (e) => void context.globalState.update(CACHE_KEY, e),
  };

  // In dev mode only (DEVKIT_DEV=1, for tests/dogfood — hardened out of the
  // published build), fall back to the DEVKIT_LICENSE_KEY env var; production
  // uses SecretStorage exclusively (no env backdoor).
  const readKey = async (devMode: boolean): Promise<string | undefined> =>
    (await context.secrets.get(SECRET_KEY)) ?? (devMode ? process.env.DEVKIT_LICENSE_KEY : undefined);

  const resolveOnce = async (): Promise<boolean> => {
    const devMode = process.env.DEVKIT_DEV === '1';
    const result = await resolveLicense({
      key: await readKey(devMode),
      verifier: polarVerifier(POLAR_ORG_ID),
      cache,
      now: Date.now(),
      devMode,
    });
    return isPro(result);
  };

  const isLicensed = (): Promise<boolean> => {
    if (!pending) {
      pending = resolveOnce().then((pro) => {
        if (!pro) pending = undefined; // not sticky: retry next call
        return pro;
      });
    }
    return pending;
  };

  const changed = (): void => {
    pending = undefined;
    emitter.fire();
  };

  return {
    isLicensed,
    onDidChange: emitter.event,
    getKey: async () => context.secrets.get(SECRET_KEY),
    async enterKey() {
      const input = await vscode.window.showInputBox({
        title: 'DevKit for Strapi — License Key',
        prompt: 'Paste your Pro license key (from your Polar receipt email). Leave empty to remove it.',
        password: true,
        ignoreFocusOut: true,
      });
      if (input === undefined) return; // cancelled
      const key = input.trim();
      if (key) await context.secrets.store(SECRET_KEY, key);
      else await context.secrets.delete(SECRET_KEY);
      changed();
      const ok = await isLicensed();
      void vscode.window.showInformationMessage(
        ok
          ? 'DevKit for Strapi: Pro unlocked. 🎉'
          : key
            ? 'DevKit for Strapi: that key could not be validated as Pro (check it, or your connection).'
            : 'DevKit for Strapi: license key removed.',
      );
    },
    async clearKey() {
      await context.secrets.delete(SECRET_KEY);
      changed();
      void vscode.window.showInformationMessage('DevKit for Strapi: license key cleared.');
    },
  };
}
