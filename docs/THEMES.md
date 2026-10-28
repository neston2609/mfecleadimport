# Light and Dark themes

The top-right theme switch is available on Login and every authenticated page, including mobile layouts. The selected theme is saved in this browser and shared across tabs on the same origin. First-time visitors use their operating system's preferred color scheme. Initialization runs in the document head before the application renders.

Theme tokens cover page surfaces, typography, muted text, inputs, read-only fields, tables, status badges, dialogs, Genesys settings and chart axes/tooltips. The switch supports keyboard activation and exposes its selected state to assistive technology.

The supplied original brand assets are retained byte-for-byte:

- Light: `public/images/mfec_black_whitetheme.png`
- Dark: `public/images/mfec_white_darktheme.png`

The white logo includes an opaque background. Its displayed image uses the transparent black logo's alpha as a CSS mask, preserving the supplied white artwork without a white rectangle. The original files are not altered.

Verified in the browser: switching both ways, persistence after reload and navigation, Login-to-workspace continuity, mobile toggle at 390px, dark source editor/dialog headers, existing Genesys settings, importer tables, badges and chart labels. No document overflow or application console errors were observed in the checked states. Existing regression suite: 26 passed.

Example screenshots use isolated test records: [Dark](design/theme-manual-dark.jpg), [Light](design/theme-manual-light.jpg).
