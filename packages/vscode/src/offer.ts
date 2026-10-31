import { currentOffer, GET_PRO_URL } from 'devkit-for-strapi-pro';
import * as vscode from 'vscode';

/**
 * A limited-time price on Pro (Black Friday), told once to a user without a
 * licence who has a Strapi project open: a few minutes into a session, never at
 * startup, and never again once shown — in any window or workspace. The dates
 * are a clock check (no network call); never shown in the extension's tests.
 */

/** The offer last shown, with when — kept for any later notice to keep its distance. */
const SHOWN_KEY = 'strapiDevkit.offerShown';
const FIRST_CHECK_MS = 3 * 60_000;
const RECHECK_MS = 60 * 60_000;

/** A Pro upsell message, with the offer running today when there is one. */
export function withOffer(message: string): string {
  const offer = currentOffer();
  return offer ? `${message} ${offer.text}` : message;
}

export function registerOfferNotice(context: vscode.ExtensionContext, isLicensed: () => Promise<boolean>, hasProject: () => boolean): void {
  if (context.extensionMode === vscode.ExtensionMode.Test) return;

  const check = async (): Promise<void> => {
    const offer = currentOffer();
    if (!offer || context.globalState.get<{ id: string }>(SHOWN_KEY)?.id === offer.id) return;
    if (!hasProject() || (await isLicensed())) return;
    await context.globalState.update(SHOWN_KEY, { id: offer.id, at: Date.now() });
    const pick = await vscode.window.showInformationMessage(`${offer.text} One-time purchase.`, 'See Pro');
    if (pick === 'See Pro') await vscode.env.openExternal(vscode.Uri.parse(GET_PRO_URL));
  };

  // Checked again every hour: a session can run into the offer's first day.
  let timer = setTimeout(function tick() {
    void check();
    timer = setTimeout(tick, RECHECK_MS);
  }, FIRST_CHECK_MS);
  context.subscriptions.push({ dispose: () => clearTimeout(timer) });
}
