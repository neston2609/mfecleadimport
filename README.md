# MFEC LeadSync

ระบบรวม Lead จาก JDBC, Web Service, CSV และ JSON เพื่อ Mapping, Filter และนำเข้า Genesys Cloud แบบ Manual หรือ Schedule

Production: https://mfecleadsync.demohub24.com/
Repository: https://github.com/neston2609/mfecleadimport

## Development

Use Node.js 24 and JDK 21+. This project supports Windows, macOS, and Linux. On this Windows ARM64 PC, Node.js 24 and Temurin JDK 21 are installed in the per-user tools directory recorded in `%LOCALAPPDATA%\MFECLeadImport\project.json`; no system-wide install or production data is used.

```sh
npm ci
npm run setup:jdbc
npm run setup:jdbc -- --test
```

For this PC, create `%LOCALAPPDATA%\MFECLeadImport\tools\use-project-tools.ps1` with the following contents, then load it in each new PowerShell session:

```powershell
. "$env:LOCALAPPDATA\MFECLeadImport\tools\use-project-tools.ps1"
npm run setup:jdbc -- --test
npm run dev:server
```

In a second terminal, load the same toolchain and run `npm run dev:client`. Open http://localhost:5175; the backend defaults to port 3002. A local-only `.env` with distinct random application and session secrets and a unique local administrator account has been created for this checkout. Never copy production secrets into the development environment. Local bootstrap credentials are stored outside the repository with Windows account-only permissions. Runtime data, credentials, legacy uploads, and backups are excluded from Git. The local data directory is separate and does not contain production source, mapping, lead, session, or Genesys configuration.

`npm run setup:jdbc` downloads the production JDBC drivers whose checksums are pinned in `server/jdbc/drivers.json` and compiles the bridge. `npm run setup:jdbc -- --test` also fetches the isolated H2 integration-test driver. Re-run after a clean checkout or when the pinned drivers change. Verify changes with `npm run build` and `npm test`; the test suite's symlink-security check requires Windows permission to create symbolic links (Developer Mode or an appropriately privileged terminal).

## Source synchronization and production safety

Before **each** change request, inspect the current branch, commit, and working tree; never pull over local modifications. Fetch all branches and tags, confirm the intended branch, and only fast-forward a clean working tree. If there are local changes or the branch has diverged, stop and preserve them before deciding how to reconcile. Record the resulting commit and confirm it is the intended source before editing. Keep development on a feature branch when practical; do not push or deploy unless explicitly requested.

Production is documented in [Production](deploy/PRODUCTION.md). Initial read-only migration inspection on 2026-11-03 confirmed production is running commit `fa9db616210afbf649e497bfaa0b5464b1daa491`, exactly matching GitHub `main`; the deployed Git tree matches, with no tracked or untracked production changes. The running service was healthy. Production's Node 22.23.3 runtime differs from the repository/CI Node 24 baseline; it was left unchanged. The production JSON data, credentials, and environment were not copied to this development PC. Before every future deployment, compare the running service's deployed commit and code/configuration with the candidate Git commit and report differences again; do not rely on this initial comparison. Back up the live code, runtime data, environment file, and JDBC dependencies before an approved deployment. Never commit or replace `/etc/mfec-leadsync.env`, `APP_SECRET`, session/admin credentials, the data directory, or backups. Do not run upgrade/restore scripts against production without an explicit request and a rehearsed, reviewed backup and rollback plan.

The SSH private key and connection metadata are kept outside this checkout under `%LOCALAPPDATA%\MFECLeadImport`; do not copy them into the repository. The verified production host fingerprint is `ssh-ed25519 255 SHA256:RSZmaYTOJeHdBa+lhIMtrXj+FBgiB6Cc0b2aEgmNClk`; re-verify it against a trusted out-of-band source if it changes. For SSH from this PC, use PuTTY `plink`/`pscp` with the protected `.ppk` key, or export it as OpenSSH with PuTTYgen's GUI before using Windows OpenSSH.

## Workspace

- Dashboard: actual integration/datasource checks and import history.
- Genesys Configuration: Region Management, Integration Setting, Contact List Configuration.
- Source Configuration: Source Integration and Source Mapping directly to a Genesys Contact List.
- Lead Configuration: named selections and filters.
- Lead Importer: Manual Import Lead and Schedule Import.
- System settings: administrator password and redacted backup downloads.

CSV/JSON Source Integrations read live from Local (Server) or SCP, SFTP, FTP,
and FTPS paths. Server browsing is confined to `SOURCE_FILE_ROOTS` (defaults to
`DATA_DIR/source-inputs`). Remote loopback, link-local, and metadata addresses
are blocked unless the exact hostname/IP is listed in
`SOURCE_REMOTE_ALLOWED_HOSTS`. FTP is unencrypted and requires explicit
confirmation in the source editor. Files are limited to 5 MB and reread for
each preview and scheduled import. Browser-computer uploads and pasted file
contents are not available for Source Integration or Schedule Import. SCP/SFTP
connections require an administrator-verified `SHA256:` SSH host-key
fingerprint; obtain it from the remote server administrator over a trusted
channel rather than trusting a value learned from an unverified connection.

Paths: /, /regions, /integration, /contact-lists, /sources, /mappings, /leads, /manual-import, /schedule-import, /settings. Previous /genesys URLs redirect to root paths. Removed feature routes return 404.

Read [Lead Workspace](docs/LEAD-WORKSPACE.md) for connector limits, import safety and JDBC support, and [Production](deploy/PRODUCTION.md) for deployment and upgrading existing data. Each application must use its own DATA_DIR and session secret. Keep exactly one scheduler per data directory.

## Verification

```sh
npm run build
npm test
```

Tests use isolated temporary data and a local Genesys test adapter. Production System Status always comes from real checks and recorded import jobs.
