# MFEC LeadSync design QA

final result: passed

## Visual targets and evidence

- Login reference: `C:/Users/ton_s/Downloads/MFEC LeadSync Data to Opportunities-1.png` (1586 × 992).
- Dashboard reference: `C:/Users/ton_s/Downloads/MFEC LeadSync Manual Import Dashboard-2.png` (1672 × 941).
- Implementation: `http://127.0.0.1:5175/`, `/login`, `/manual-import`, using isolated fixtures and mocked Genesys responses.
- Desktop captures: [Login](docs/design/login-final.jpg), [Manual Import](docs/design/dashboard-final.jpg).
- Mobile captures: [Login](docs/design/login-mobile.jpg), [Manual Import](docs/design/manual-mobile.jpg).
- Both source images and implementation captures were rendered together at equal column widths in a comparison page: [full comparison](docs/design/reference-comparison.jpg), [focused comparison](docs/design/focused-comparison.jpg).
- CSS viewports: Login 1586 × 992; dashboard 1672 × 941; mobile 390 × 844. The browser export can omit scrollbar pixels and scale its JPEG slightly; comparisons normalize each complete image to the same column width. Dashboard JPEG is 1657 × 933; mobile JPEGs 375 × 812. No device frame is included.
- Sources are prototypes: production counters, records, schemas, recent imports and chart values intentionally come from real application data. The test capture shows eight sample records and one successful three-record mock import.

## Comparison history

1. Initial implementation: P2 dashboard metric hints wrapped, table column minimum widths caused unnecessary horizontal scrolling, row actions enlarged row heights, and Login checkbox inherited a 42px minimum height.
2. Fixed metric overflow, bounded default fields with an explicit Show all fields option, reduced desktop row padding, corrected checkbox height, and aligned the Login form. Re-captured both screens and compared them together with the references. The primary fields, import actions and five-row table retain the reference's proportions.
3. Confirmed the selected-record import through an accessible application dialog; completed a three-record import against a local mock. Checked synced records, selection across pages, search, pagination and the resulting real history/chart updates. No production contacts were created during QA.

## Required fidelity surfaces

- **Typography:** Inter for Latin UI and Prompt fallback for Thai; compact table/body hierarchy, bold navy titles and readable form labels. No clipped primary labels at tested desktop/mobile widths.
- **Spacing/layout:** white 64px header, navy sidebar, pale blue workspace, four summary cards, primary import card and three-card right rail. Mobile uses stacked fields, a two-column metric grid, horizontal scrolling within the table and a navigation drawer. Document width does not exceed viewport width.
- **Colors:** navy text/sidebar, blue active navigation/actions, pale blue surfaces and green readiness/success states are consistent with the supplied references.
- **Images:** source-guided generated raster hero and transparent MFEC LeadSync wordmark; no screenshot is substituted for the working application. Hero stays decorative while authentication inputs are real HTML controls. Standard UI icons use the existing Lucide library, charts use Recharts.
- **Copy/content:** titles follow the prototype. Existing username-based authentication remains available; Remember username stores only the username. Microsoft/Google options are visibly unavailable because SSO is not configured. Recovery help directs the user to their administrator.

## Interaction and accessibility checks

- Existing sign-in/sign-out; show/hide password; account recovery help; disabled SSO explanation.
- Automatic preview, single-page/multiple-page selection, search and pagination.
- Confirmation dialog, job progress and successful local mock import; existing synced records stay non-importable.
- Data tools retain CSV export, all fields, contact-list refresh, clear-list safeguards and per-record import/reconcile actions.
- Sidebar groups, mobile drawer, account menu and notifications use real buttons/links; page links retain existing routes.
- Dialogs close with Escape, trap Tab and restore previous focus. Focus outlines and reduced-motion handling remain visible.
- Browser console: no application errors during the checked import workflow.
- TypeScript/build passed; existing automated suite: 26 passed, 0 failed, 0 skipped.

## Follow-up polish

- P3: pale geometric background decoration and filled provider logos from the prototype are simplified; inactive SSO controls use neutral icons.
- P3: custom source schemas use their actual field names, so column labels and widths vary from the fixed insurance example.
- No outstanding P0/P1/P2 findings.

## Implementation checklist

- [x] Match both supplied screen compositions.
- [x] Preserve existing backend, account and import behavior.
- [x] Verify desktop, mobile, import workflow and console.
- [x] Capture and compare source/implementation together after fixes.
- [x] Run build and regression checks before GitHub/Production deployment.
