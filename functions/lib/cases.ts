export type CaseStatus =
  | 'draft'
  | 'deposited'
  | 'uploaded'
  | 'in_review'
  | 'declined'
  | 'rescued'
  | 'balance_due'
  | 'paid_in_full'
  | 'delivered'
  | 'invalid_file'
  | 'closed';

export type DownloadKind = 'source' | 'rescue' | 'notes';

export interface DownloadLink {
  kind: DownloadKind;
  filename: string;
  token: string;
}

export interface CaseRecord {
  id: string;
  email: string;
  name: string;
  notes: string;
  service: string;
  status: CaseStatus;
  stripeDepositPi: string | null;
  stripeBalancePi: string | null;
  createdAt: string;
  r2Key?: string;
  r2RescueWav?: string;
  r2RescueMp3?: string;
  r2Notes?: string;
  declineNote?: string;
  balanceCheckoutUrl?: string;
  downloadLinks?: DownloadLink[];
}

export function caseKey(id: string): string {
  return `case:${id}`;
}

export function newCaseId(): string {
  return crypto.randomUUID();
}

export async function getCase(
  kv: KVNamespace,
  id: string,
): Promise<CaseRecord | null> {
  const raw = await kv.get(caseKey(id));
  if (!raw) return null;
  return JSON.parse(raw) as CaseRecord;
}

export async function putCase(kv: KVNamespace, record: CaseRecord): Promise<void> {
  await kv.put(caseKey(record.id), JSON.stringify(record));
}

export function downloadAssetsFor(
  record: CaseRecord,
): Array<{ kind: DownloadKind; r2Key: string; filename: string }> {
  const out: Array<{ kind: DownloadKind; r2Key: string; filename: string }> = [];
  if (record.r2Key) {
    const ext = record.r2Key.toLowerCase().endsWith('.mp3') ? 'mp3' : 'wav';
    out.push({ kind: 'source', r2Key: record.r2Key, filename: `${record.id}-source.${ext}` });
  }
  if (record.r2RescueWav) {
    out.push({ kind: 'rescue', r2Key: record.r2RescueWav, filename: `${record.id}-rescue.wav` });
  }
  if (record.r2RescueMp3) {
    out.push({ kind: 'rescue', r2Key: record.r2RescueMp3, filename: `${record.id}-rescue.mp3` });
  }
  if (record.r2Notes) {
    out.push({ kind: 'notes', r2Key: record.r2Notes, filename: `${record.id}-notes.txt` });
  }
  return out;
}

export async function listCases(kv: KVNamespace): Promise<CaseRecord[]> {
  const out: CaseRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: 'case:', cursor });
    for (const k of page.keys) {
      const raw = await kv.get(k.name);
      if (!raw) continue;
      try {
        out.push(JSON.parse(raw) as CaseRecord);
      } catch {
        /* skip corrupt rows */
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return out;
}
