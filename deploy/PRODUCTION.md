# Production

- URL: https://mfecleadsync.demohub24.com/ (opens the Genesys workspace)
- Code: /opt/mfecleadimport
- Service: mfec-leadsync.service
- Internal port: 127.0.0.1:3102
- Environment: /etc/mfec-leadsync.env
- Data: /var/lib/mfec-leadsync/data
- Backups: /var/backups/mfec-leadsync

The initial migration copies local source records, Genesys configuration, and the administrator password hash from the legacy application. APP_SECRET is preserved to decrypt the existing Genesys Client Secret; SESSION_SECRET is unique to this service. No sessions are copied. Runtime records, secrets, and credentials are excluded from Git.

For updates, back up data and environment files, pull this repository, run `npm ci`, `npm run build`, and `npm test`, then `sudo systemctl restart mfec-leadsync`. Check `systemctl status mfec-leadsync`, `journalctl -u mfec-leadsync`, and `/api/health`.

HTTPS uses the domain's Let's Encrypt certificate and the server's existing Certbot renewal timer and Nginx reload hook. Run only one scheduler process for this data directory. Review migrated schedules before enabling them alongside the legacy deployment.
