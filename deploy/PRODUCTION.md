# Production

- Server: 18.142.92.2 (SSH user: ubuntu)
- URL: https://mfecleadsync.demohub24.com/ (serves the workspace directly)
- Code: /opt/mfecleadimport
- Service: mfec-leadsync.service
- Internal port: 127.0.0.1:3102
- Environment: /etc/mfec-leadsync.env
- Data: /var/lib/mfec-leadsync/data
- Backups: /var/backups/mfec-leadsync

The revised workspace uses `/contact-lists`, `/sources`, `/mappings`, `/leads`, `/integration`, `/regions`, `/manual-import` and `/schedule-import`. See [Lead Workspace](../docs/LEAD-WORKSPACE.md). Install JDK 21+ and run `npm run setup:jdbc` before enabling JDBC sources. Source uploads require the 12 MB Nginx body limit supplied in `mfecleadsync.nginx.conf`.

The workspace uses root paths such as `/manual-import`, `/regions`, `/schedule-import`, and `/settings`. Previous `/genesys` page URLs permanently redirect to the corresponding root path, preserving query parameters. Genesys API URLs remain under `/api/admin/genesys`.

The initial migration copies local source records, Genesys configuration, and the administrator password hash from the legacy application. APP_SECRET is preserved to decrypt the existing Genesys Client Secret; SESSION_SECRET is unique to this service. No sessions are copied. Runtime records, secrets, and credentials are excluded from Git.

For updates, back up data and environment files, pull this repository, run `npm ci`, `npm run build`, and `npm test`, then `sudo systemctl restart mfec-leadsync`. Check `systemctl status mfec-leadsync`, `journalctl -u mfec-leadsync`, and `/api/health`.

HTTPS uses the domain's Let's Encrypt certificate and the server's existing Certbot renewal timer and Nginx reload hook. Run only one scheduler process for this data directory. Review migrated schedules before enabling them alongside the legacy deployment.

## Upgrade from templates and legacy source records

Before replacing the previous release, stop only mfec-leadsync and back up its source, runtime data, environment and JDBC dependencies. With the previous release still installed, run the new release's `deploy/prepare-workspace-upgrade.mjs` using the previous release path as its first argument and its existing DATA_DIR / APP_SECRET environment. This exports current legacy source records and remote contact identities without writing to Genesys.

Then install the new release and start the service. Startup converts the exported records into JSON Source Integrations, preserving source/mapping/lead/schedule IDs and remote identities. Existing mappings are linked to their actual Genesys Contact List ID and typed field metadata is retained. Old templates, insurance records and campaign files are archived under BACKUPS_DIR/workspace-upgrade-* rather than left as active features. The application refuses to upgrade an old source without the snapshot. Repeated startup is idempotent. Converted source records are snapshots; future feeds should use configured JDBC, Web Service or uploaded CSV/JSON integrations.

Rehearse against a separate copy of production data first. Keep schedulers disabled in that copy. Validate list retrieval, all migrated lead previews, identity retention and actual datasource checks before switching production. If startup or health checks fail, restore the previous code, dependencies and complete runtime directory from backup before restarting. Preserve APP_SECRET and administrator credentials.
