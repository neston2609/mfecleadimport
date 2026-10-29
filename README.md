# MFEC LeadSync

ระบบรวม Lead จาก JDBC, Web Service, CSV และ JSON เพื่อ Mapping, Filter และนำเข้า Genesys Cloud แบบ Manual หรือ Schedule

Production: https://mfecleadsync.demohub24.com/
Repository: https://github.com/neston2609/mfecleadimport

## Development

Use Node.js 24 and JDK 21+.

```sh
npm ci
npm run setup:jdbc -- --test
npm run dev:server
npm run dev:client
```

Frontend: http://localhost:5175. Backend defaults to port 3002. Configure APP_SECRET, SESSION_SECRET, ADMIN_USERNAME and ADMIN_PASSWORD in the local environment. Runtime data, credentials, legacy uploads and backups are excluded from Git. New installations start with empty source/mapping/lead configuration.

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
