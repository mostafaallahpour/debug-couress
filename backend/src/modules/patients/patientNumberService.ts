import { sqlite } from '../../config/database';
import { normalizeDigits } from '../../utils/validation';

/**
 * Returns the next valid physical file number for a specific practice.
 *
 * Rules:
 * 1. Strictly independent per practice ('aesthetic' vs 'dental').
 * 2. Next number = MAX(valid physical file numbers for that practice) + 1.
 * 3. Compares numerically (integer value), correctly handling numeric strings.
 * 4. If no valid file numbers exist in that practice, starts from '1'.
 * 5. Strictly independent of total patient count, internal patient IDs, other practices, or arbitrary offsets.
 */
export function getNextPhysicalFileNumber(practice: 'aesthetic' | 'dental'): string {
  const rows = sqlite.prepare(`
    SELECT physical_file_number
    FROM patient_practice_memberships
    WHERE practice = ?
  `).all(practice) as { physical_file_number: string | null }[];

  let maxNum = 0;
  for (const r of rows) {
    if (!r.physical_file_number) continue;
    const normalized = normalizeDigits(r.physical_file_number).trim();
    const digitsOnly = normalized.replace(/\D/g, '');
    if (digitsOnly) {
      const parsed = parseInt(digitsOnly, 10);
      if (Number.isSafeInteger(parsed) && parsed > maxNum) {
        maxNum = parsed;
      }
    }
  }

  return String(maxNum + 1);
}
