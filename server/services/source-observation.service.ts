import {
  sourceIntegrations,
  sourceObservations,
} from "../domain/pipeline-store";
import type { SourceObservation } from "../domain/pipeline-types";
export async function recordSourceObservation(
  id: string,
  status: SourceObservation["status"],
  message: string,
) {
  if (!(await sourceIntegrations.findById("id", id))) return;
  await sourceObservations.mutate((rows) => {
    const value = { id, status, message, checkedAt: new Date().toISOString() };
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) rows.push(value);
    else rows[index] = value;
  });
}
