import "./footer.css";

declare const __SOURCE_UPDATED_AT__: string | null;

export function Footer() {
  const updatedAt = __SOURCE_UPDATED_AT__
    ? new Date(__SOURCE_UPDATED_AT__)
    : null;
  const timestamp = updatedAt
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Bangkok",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(updatedAt)
    : null;

  return (
    <footer className="ls-footer">
      <span>© 2026 MFEC Public Company Limited. All Rights Reserved.</span>
      <span>
        Designed &amp; Developed by{" "}
        <strong>MFEC Automation Excellence Team</strong>
      </span>
      <span className="ls-footer-updated">
        Last Updated:{" "}
        {updatedAt ? (
          <time dateTime={updatedAt.toISOString()}>{timestamp} (UTC+7)</time>
        ) : (
          "Unavailable"
        )}
      </span>
    </footer>
  );
}
