# Lead workspace

The workspace runs at https://mfecleadsync.demohub24.com/. Administration still requires the existing administrator account. Configuration and source credentials remain server-side; database passwords and Web Service tokens are encrypted with APP_SECRET.

## 1. Contact List Template

Open **Contact List Template**, create a named template and add fields. Field types are String, Number, Date, Boolean and Phone; required fields must be mapped or given a default value.

Alternatively, select a Genesys Contact List and click **Import fields**. The application reads its exact column names and phone columns and fills the open editor. This does not save the template. Review the name, types and required flags, then click **Save Template**. Changes are discarded if the editor is cancelled.

Templates used for an import must match the selected Genesys Contact List's columns. The import path supports custom schemas and does not require the legacy insurance application's 23 columns.

## 2. Source Configuration

### Source Integration

- **Database / JDBC:** enter a JDBC URL, username and password. Click **Connect & list tables**, select a table/view or enter a single SELECT query, and click **Preview data & fields**. Use a database account with read-only permissions. The application limits queries to one SELECT, rolls back the connection and times requests out after 30 seconds.
- **Web Service:** enter the final HTTP(S) URI, GET or POST, and optional JSON request body. Authentication supports none, Basic, Bearer and an API key header. A response must contain JSON. Use a response data path such as `data.customers` when the array is nested; common array wrappers such as `items`, `data`, `records`, `results` and `entities` are recognized automatically. Configure upstream pagination/query parameters to return the required records; arbitrary pagination links and redirect responses are not followed automatically.
- **CSV:** upload UTF-8 CSV, or paste its content. Comma, semicolon and tab delimiters are supported. Quoted values, multiline values and BOM are supported. Headers must be unique and non-empty.
- **JSON:** upload/paste a JSON array, a single object, or an object containing the records. Optional response data paths work as for Web Services. Nested object fields are flattened, for example `customer.name`.

Each preview shows the actual field names and up to 100 rows. Uploaded files remain on the server for subsequent scheduled runs. Replacing a file writes a new immutable version before committing its configuration; a rejected save cannot overwrite the existing source file.

Files and Web Service responses are limited to 5 MB, sources to 200 fields and 10,000 records. A truncated source is clearly flagged and is blocked from importing, so **Import all** cannot silently import only a partial dataset. Narrow the SQL query or upstream Web Service request when necessary. JDBC requests run one at a time to bound resource use on the deployment server.

Loopback Web Service hosts require an explicit `SOURCE_ALLOWED_HOSTS` environment entry. Metadata and link-local destinations are blocked. Private network services are supported when reachable from this server.

### Source Mapping

Select a Contact List Template and Source Integration, give the mapping a name, and select a **stable, unique record key** from the source. Map each target field to a source field or a default value. Auto-match fills fields whose names are identical; it does not save the mapping.

The record key must identify the same source record on future runs. Record keys are limited to 256 characters and mapped field values to 4,000 characters. Do not use a row number that changes between requests.

## 3. Lead Configuration

Give the lead a name and select a Source Mapping. Filters can use mapped fields or original source fields. Available operators are equals, not equals, contains, greater/less than, greater/less or equal, and date offsets. Combine filters with AND or OR.

Date offsets use calendar days in **Asia/Bangkok**. Positive values are future days, negative values are past days. For example, `Date < -30` selects dates older than 30 days; `Date > 0` plus `Date < 30` selects dates after today and before 30 days from today. Invalid/empty numeric or date values do not pass numeric/date comparisons.

## 4. Genesys Configuration

**Integration settings** and **Region management** retain the existing connection/region functions under the Genesys Configuration menu. OAuth credentials are reused. Contact List validation checks the destination's fields and phone configuration; the selected Template is validated against the actual destination again when importing.

## 5. Lead Importer

### Manual Import

Select a Lead Configuration to load current data automatically. Choose a Genesys Contact List. Import individual records, selected records across pages, or every eligible record. Export CSV is also available.

The importer validates required fields, field types, phone numbers, duplicate keys/phones and source DNC flags. Unchanged contacts are skipped. Changed contacts retain their remote Contact ID and are updated while preserving unrelated Genesys contact properties. The destination selection is per import and does not change global configuration.

Import jobs run in the background and show progress. Recent history retains 100 jobs and the latest 200 per-record results in each job. A durable contact-identity journal is synchronized before creating remote contacts. Unknown creation outcomes are not automatically retried; after checking the destination, use **Reconcile** to link the existing Genesys Contact ID. Only one import/clear operation runs at a time; individual contacts are processed with bounded concurrency.

**Clear list** retains the previous destructive operation and requires typing CLEAR. It removes all contacts in the selected Genesys Contact List and resets local identities for that destination.

### Schedule Import

Choose a Lead Configuration and destination Contact List. Configure daily, weekly, monthly or selected dates such as 1 and 15 of every month, choose the Bangkok time and enable the schedule. Each run fetches fresh data and re-evaluates its filters. Monthly dates that do not exist, such as February 31, are skipped. Missed periods are not replayed as duplicate historical imports.

Schedules can be edited, paused, enabled, run immediately and deleted. Results and next run times are visible in the schedule table. Run exactly one scheduler instance per DATA_DIR.

## JDBC setup and additional database drivers

Use JDK 21+ and Node.js. On Ubuntu:

```sh
sudo apt-get install --no-install-recommends openjdk-21-jdk-headless
npm run setup:jdbc
```

This downloads and verifies the SHA-256 pinned drivers in `server/jdbc/drivers.json` and compiles `JdbcBridge.java`. Included drivers support PostgreSQL, MySQL, Microsoft SQL Server, Oracle and MariaDB. Their upstream documentation is available at [pgJDBC](https://jdbc.postgresql.org/), [MySQL Connector/J](https://dev.mysql.com/doc/connector-j/en/), [Microsoft JDBC](https://learn.microsoft.com/en-us/sql/connect/jdbc/microsoft-jdbc-driver-for-sql-server), [Oracle JDBC](https://www.oracle.com/database/technologies/appdev/jdbc-downloads.html) and [MariaDB Connector/J](https://mariadb.com/docs/connectors/mariadb-connector-j).

For another JDBC-compatible database, an administrator installs its official driver and required companion JARs in `server/jdbc/drivers/`, then uses that database's JDBC URL. For drivers without JDBC 4 service registration, enter their driver class in the Source Integration editor. Database-specific licensing, network access, supported JVM versions and authentication options still apply. Protocols without a suitable JDBC driver use the Web Service or file connectors instead.

`JAVA_BIN` and `JDBC_HOME` can override the Java executable and JDBC directory. Passwords are passed to Java over stdin, never in process arguments or log output. The H2 driver is installed only with `npm run setup:jdbc -- --test` for the isolated integration test; production source configuration rejects H2 unless JDBC_TEST_H2 is explicitly enabled for tests.

## Existing data and backups

Existing campaigns are migrated idempotently into a template, legacy source adapters, mappings and Lead Configurations. Their previous Genesys Contact IDs are preserved to avoid recreating contacts. Recurring legacy schedules are moved to the new scheduler and disabled in the old scheduler. Legacy source screens and one-time schedules remain under the collapsed Legacy menu.

Runtime JSON, uploaded source files, import states/journal and credentials remain outside Git. System Settings backups include the current contact-state snapshot and referenced source files; downloaded backups omit encrypted source credentials and Genesys credentials. Filesystem disaster recovery must preserve DATA_DIR and the environment file containing APP_SECRET.
