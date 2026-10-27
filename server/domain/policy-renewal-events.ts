export type PolicyRenewalEvent = {
  policyId: string;
  policyNumber: string;
  expiryDate: string;
  renewalStatus: "RENEWED";
};

const listeners = new Set<(event: PolicyRenewalEvent) => void>();

export function subscribeToPolicyRenewals(
  listener: (event: PolicyRenewalEvent) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishPolicyRenewal(event: PolicyRenewalEvent): void {
  for (const listener of listeners) listener(event);
}
