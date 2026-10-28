import { Router } from "express";
import { requireAdmin } from "../middleware/require-admin";
import {
  createBackup,
  downloadBackup,
  writeBackupManifest,
} from "../domain/business";
export const adminDataRouter = Router();
adminDataRouter.use(requireAdmin);
adminDataRouter.post("/settings/backup", async (_req, res) => {
  const result = await createBackup();
  await writeBackupManifest(result.directory, result.files);
  res
    .status(201)
    .json({
      ...result,
      downloadUrl: `/api/admin/settings/backups/${result.directory}/download`,
    });
});
adminDataRouter.get("/settings/backups/:stamp/download", async (req, res) => {
  const data = await downloadBackup(req.params.stamp);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="mfec-backup-${req.params.stamp}.json"`,
  );
  res.json({
    note: "Credentials and encryption keys are excluded from downloaded backups.",
    files: data,
  });
});
