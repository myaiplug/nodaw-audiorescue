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
