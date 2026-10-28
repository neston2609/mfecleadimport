# Footer and Last Updated

Login and authenticated pages share the same footer and support both themes and mobile widths.

**Last Updated** is the commit timestamp of the latest change to application/server sources, public assets or build/deployment configuration. Vite embeds that timestamp in the client bundle; rendering the page or rebuilding the same source revision does not replace it with the current time. The displayed time uses Asia/Bangkok (UTC+7).

Release builds must run after committing the source changes. CI fetches full Git history so documentation-only commits can retain the actual preceding source timestamp. When Git history is unavailable, the footer explicitly shows Unavailable instead of inventing a date.
