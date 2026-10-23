/** Jev's router mark: one line in, three lanes out, the chosen lane in the accent color. Stays legible at favicon size. */
const LANES = 'M4 24H18M18 24C26 24 26 10 34 10M18 24H34M18 24C26 24 26 38 34 38';
const SVG = 'viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"';
export const JEV_MARK = `<svg ${SVG} aria-hidden="true"><path d="${LANES}" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round"/><circle cx="38" cy="10" r="4" fill="currentColor"/><circle cx="38" cy="38" r="4" fill="currentColor"/><circle class="mark-dot" cx="38" cy="24" r="6"/></svg>`;
export const JEV_FAVICON = `<svg ${SVG}><style>.l{fill:none;stroke:#24212c;stroke-width:4.5;stroke-linecap:round}.n{fill:#24212c}.d{fill:#2563eb}@media(prefers-color-scheme:dark){.l{stroke:#f0f0f5}.n{fill:#f0f0f5}.d{fill:#4b8df8}}</style><path class="l" d="${LANES}"/><circle class="n" cx="38" cy="10" r="4"/><circle class="n" cx="38" cy="38" r="4"/><circle class="d" cx="38" cy="24" r="6"/></svg>`;
