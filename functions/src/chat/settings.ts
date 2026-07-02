/**
 * Editable chat-assistant settings, stored on the tenant doc so the practice
 * can update what the bot "knows" from the admin (Settings → Chat assistant)
 * without a deploy. Blank/absent => the built-in PRACTICE_INFO default.
 */
import { tenantRef } from '../firebase';

const FIELD = 'chatPracticeInfo';
export const PRACTICE_INFO_MAX_LEN = 20_000;

/** The saved practice-info override, or '' when none is set. */
export async function loadPracticeInfoOverride(tenantId: string): Promise<string> {
  const snap = await tenantRef(tenantId).get();
  const v = snap.exists ? (snap.get(FIELD) as unknown) : undefined;
  return typeof v === 'string' ? v.trim() : '';
}

/** Save (or clear, with '') the practice-info override. */
export async function savePracticeInfoOverride(tenantId: string, text: string): Promise<void> {
  await tenantRef(tenantId).set(
    { [FIELD]: text.slice(0, PRACTICE_INFO_MAX_LEN), updatedAt: new Date().toISOString() },
    { merge: true },
  );
}
