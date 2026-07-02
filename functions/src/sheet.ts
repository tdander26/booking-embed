import { google } from 'googleapis';
import { logger } from 'firebase-functions';

/**
 * Appends lab orders to the "Momentum — Lab Orders" Google Sheet (owned by
 * doc@drtoddanderson.com). PHI stays inside Google's BAA-covered services
 * (Cloud Functions -> Sheets, both under Google's BAA).
 *
 * Requirements for appends to succeed (failures are logged, never thrown, so
 * a missing setup step never breaks a patient's submission):
 *  1. The Sheet is shared (Editor) with this function's runtime service account
 *     (…-compute@developer.gserviceaccount.com).
 *  2. The Google Sheets API is enabled on the momentum-booking project.
 */
const SHEET_ID = '1V0Cbwr9NvkyTbXzQZRDhPMosrecMb5h12x80nsM16yw';

let sheetsApi: ReturnType<typeof google.sheets> | null = null;
function sheets() {
  if (!sheetsApi) {
    // Application Default Credentials = the function's service account.
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheetsApi = google.sheets({ version: 'v4', auth });
  }
  return sheetsApi;
}

/** Append one row. Best-effort: logs and swallows any error. */
export async function appendLabOrderRow(values: Array<string | number>): Promise<void> {
  try {
    await sheets().spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'A1',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [values] },
    });
  } catch (err) {
    logger.error('lab_order_sheet_append_failed', err);
  }
}
