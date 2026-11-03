# Production

## Verified deployment baseline (2026-11-03)

Read-only inspection after independent SSH host-key verification confirmed the server checkout is on `main`, clean, and at `fa9db616210afbf649e497bfaa0b5464b1daa491`, exactly the same commit/tree as GitHub `origin/main` at that time. There were no tracked differences or untracked files under the application checkout. The `mfec-leadsync.service` unit was active/running from `/opt/mfecleadimport`, bound to the documented localhost port, and `/api/health` returned success.

The active installation is not a fresh empty instance: it has a separate, populated JSON `DATA_DIR` containing Genesys region/connection configuration, protected administrator credentials, contact-list/source/mapping/lead/schedule configuration, import state/history, audit history, and source files. It also has dated release and workspace-upgrade backups. Only file names, sizes, timestamps, ownership, and permissions were inspected; production data contents, secrets, credentials, and backups were not retrieved to the development machine. Preserve all of these existing files and identifiers.

The production host reports Node `v22.23.3` and Java `21.0.12.1`. The repository's README and CI specify Node 24 and JDK 21; production currently differs on Node major version. This discrepancy was recorded for a future, separately reviewed compatibility/runtime change and the production runtime was not altered during migration. The dependency installation and JDBC driver directory exist under the application path. The environment file has mode `0640 root:www-data`; its values/secrets were not printed. Service account `www-data` owns the data directory (`0700`) and `/var/backups/mfec-leadsync` (`0700`).

This baseline is a time-stamped observation, not a deployment authorization. Recheck the live commit, tree, working state, runtime, environment names, service health, and data/backup locations immediately before any later deployment.

- Server: 18.142.92.2 (SSH user: ubuntu)
- URL: https://mfecleadsync.demohub24.com/ (serves the workspace directly)
- Code: /opt/mfecleadimport
- Service: mfec-leadsync.service
- Internal port: 127.0.0.1:3102
- Environment: /etc/mfec-leadsync.env
- Data: /var/lib/mfec-leadsync/data
- Backups: /var/backups/mfec-leadsync

The revised workspace uses `/contact-lists`, `/sources`, `/mappings`, `/leads`, `/integration`, `/regions`, `/manual-import`, `/file-import`, `/schedule-import` and `/settings`. File Import requires the Contact List to be selected before browsing; it checks matching columns and a unique record ID before previewing/importing CSV or JSON (maximum 5 MB and 10,000 rows). Configuration restore accepts downloaded MFEC JSON backups, makes a safety backup, preserves local credentials and contact identities, and restores schedules disabled. See [Lead Workspace](../docs/LEAD-WORKSPACE.md). Install JDK 21+ and run `npm run setup:jdbc` before enabling JDBC sources. Configure `SOURCE_FILE_ROOTS` in `/etc/mfec-leadsync.env` for administrator-approved local import folders (default: `/var/lib/mfec-leadsync/data/source-inputs`); ensure the service account can read those files. Configure `SOURCE_REMOTE_ALLOWED_HOSTS` only when an administrator has explicitly approved an internal remote host. Browser file uploads are not used for Source Integration or scheduled imports.

The workspace uses root paths such as `/manual-import`, `/regions`, `/schedule-import`, and `/settings`. Previous `/genesys` page URLs permanently redirect to the corresponding root path, preserving query parameters. Genesys API URLs remain under `/api/admin/genesys`.

The initial migration copies local source records, Genesys configuration, and the administrator password hash from the legacy application. APP_SECRET is preserved to decrypt the existing Genesys Client Secret; SESSION_SECRET is unique to this service. No sessions are copied. Runtime records, secrets, and credentials are excluded from Git.

## Controlled deployment and rollback

Production deployments are intentionally manual. Do not deploy just because a branch has changed. First confirm approval, the exact commit to release, and a clean, tested checkout. From an authenticated SSH session, record the live service state and compare the deployed code with the candidate before changing anything:

```sh
cd /opt/mfecleadimport
git status --short --branch
git rev-parse HEAD
git log -1 --format='%H %cI %s'
git diff --stat
sudo systemctl status mfec-leadsync --no-pager
curl --fail --silent --show-error http://127.0.0.1:3102/api/health
```

If the deployed release is a Git checkout, fetch without changing the worktree and compare its tracked/untracked changes and commits against the reviewed candidate. If it is not a Git checkout, compare a downloaded copy or file manifest/checksums against the candidate. Do not assume production matches GitHub, and do not overwrite locally modified production files. Compare `/etc/mfec-leadsync.env` names and non-secret settings without printing or copying secret values. Record actual runtime-data, backups, and JDBC locations; never assume an environment or schema matches merely because its path is documented.

Schedule a maintenance window. Before deployment, create a timestamped, access-restricted backup **outside** the live application directory. Include the full application tree (including JDBC drivers), complete `/var/lib/mfec-leadsync/data`, `/etc/mfec-leadsync.env`, and any separately configured JDBC dependencies. Check available disk space, archive completion, permissions, and the archive listing; retain the production backup and never stage it in Git:

```sh
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="/var/backups/mfec-leadsync/releases/$stamp"
sudo install -d -m 0700 "$backup"
sudo systemctl stop mfec-leadsync
sudo tar --acls --xattrs -C / -cpf "$backup/app.tar" opt/mfecleadimport
sudo tar --acls --xattrs -C / -cpf "$backup/data.tar" var/lib/mfec-leadsync/data var/lib/mfec-leadsync/exports
sudo cp -a /etc/mfec-leadsync.env "$backup/mfec-leadsync.env"
sudo chmod 0600 "$backup/mfec-leadsync.env"
sudo sha256sum "$backup"/*.tar "$backup/mfec-leadsync.env" | sudo tee "$backup/SHA256SUMS"
sudo tar -tf "$backup/app.tar" >/dev/null
sudo tar -tf "$backup/data.tar" >/dev/null
```

If the service cannot be stopped for a consistent backup, do not improvise a live copy: arrange an application-consistent backup and verify that it can be restored first. Preserve the existing `APP_SECRET`, administrator credentials, data, and JDBC driver files. Do not run `deploy/prepare-workspace-upgrade.mjs`, configuration restore, database/schema changes, or any migration on production without a separately reviewed, rehearsed migration plan and explicit approval.

Only after reviewing the backup and candidate comparison, update the code to the specifically approved commit, install its locked dependencies, prepare JDBC drivers as required, and run the production checks (`npm ci`, `npm run build`, `npm test`, plus `npm run setup:jdbc` if required). Preserve the existing environment and runtime data; do not run `npm run setup:jdbc -- --test` or enable test adapters in production. Start the one production scheduler and verify the service, recent logs, health endpoint, UI, and application integrations before closing maintenance:

```sh
sudo systemctl start mfec-leadsync
sudo systemctl status mfec-leadsync --no-pager
sudo journalctl -u mfec-leadsync -n 100 --no-pager
curl --fail --silent --show-error http://127.0.0.1:3102/api/health
```

### Rollback

If startup, health, or application checks fail, stop the service and restore the matching application release and JDBC drivers from the verified backup (not only selected source files). **For an ordinary code rollback, leave the live DATA_DIR, exports, and environment file in place.** Restoring an older data snapshot can erase later imports, audit records, and contact reconciliation state. Restore the data snapshot only when an approved data-format/corruption recovery plan specifically requires it and its post-backup data-loss consequences have been reviewed. Keep the failed release and logs for diagnosis; preserve them in a separate archive before synchronizing the old application tree.

```sh
sudo systemctl stop mfec-leadsync
# Set $backup to the exact reviewed release-backup directory.
command -v rsync
restore=$(sudo mktemp -d /var/backups/mfec-leadsync/restore.XXXXXX)
sudo tar --acls --xattrs -C "$restore" -xpf "$backup/app.tar"
sudo test -d "$restore/opt/mfecleadimport"
# Preserve the failed release and logs before restoring the old code.
sudo tar --acls --xattrs -C / -cpf "$backup/failed-app.tar" opt/mfecleadimport
sudo rsync -aHAX --numeric-ids --delete \
  "$restore/opt/mfecleadimport/" /opt/mfecleadimport/
sudo systemctl start mfec-leadsync
sudo systemctl status mfec-leadsync --no-pager
sudo journalctl -u mfec-leadsync -n 100 --no-pager
curl --fail --silent --show-error http://127.0.0.1:3102/api/health
```

Only under the separately approved data-recovery plan, first preserve the current failed data/exports, extract the matching verified `data.tar` into the same `$restore` directory, verify the extracted paths and archive checksums, then synchronize the exact `var/lib/mfec-leadsync/data` and `var/lib/mfec-leadsync/exports` trees with `rsync -aHAX --numeric-ids --delete`. This rolls back application data to the backup timestamp and can discard all writes since then; reconcile those events with Genesys before resuming imports. Never restore only selected JSON files or run the data restore as an automatic step for a routine code rollback. Keep `/etc/mfec-leadsync.env` unchanged. Confirm the restored release, health, and integrations, then retain the verified release backup, failed-release archive, and failure logs according to the server retention policy. For changes that alter persistent data formats, use the documented upgrade procedure above: restoring old code against upgraded data is not safe unless that exact recovery has first been rehearsed.

HTTPS uses the domain's Let's Encrypt certificate and the server's existing Certbot renewal timer and Nginx reload hook. Run only one scheduler process for this data directory. Review migrated schedules before enabling them alongside the legacy deployment.

## Upgrade from templates and legacy source records

Before replacing the previous release, stop only mfec-leadsync and back up its source, runtime data, environment and JDBC dependencies. With the previous release still installed, run the new release's `deploy/prepare-workspace-upgrade.mjs` using the previous release path as its first argument and its existing DATA_DIR / APP_SECRET environment. This exports current legacy source records and remote contact identities without writing to Genesys.

Then install the new release and start the service. Startup converts the exported records into JSON Source Integrations, preserving source/mapping/lead/schedule IDs and remote identities. Existing mappings are linked to their actual Genesys Contact List ID and typed field metadata is retained. Old templates, insurance records and campaign files are archived under BACKUPS_DIR/workspace-upgrade-* rather than left as active features. The application refuses to upgrade an old source without the snapshot. Repeated startup is idempotent. Converted source records are snapshots; future feeds should use configured JDBC, Web Service or server-local/remote CSV/JSON files.

Rehearse against a separate copy of production data first. Keep schedulers disabled in that copy. Validate list retrieval, all migrated lead previews, identity retention and actual datasource checks before switching production. If startup or health checks fail, restore the previous code, dependencies and complete runtime directory from backup before restarting. Preserve APP_SECRET and administrator credentials.
