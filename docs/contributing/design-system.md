# Design system

randl's interface is built from IBM Carbon (`carbon-components-svelte`) with a few patterns of
its own. This page is the checklist for interface changes: structure, the shared components, colour,
layout, chart behaviour, writing and localization.

## Product structure

- Organize around objects: projects, runs, views, panels, artifacts, findings, plans.
- Each page has one purpose and at most one primary action.
- Project navigation, page controls, filters and item actions each have their own place.
  Frequent actions sit where the task happens; infrequent ones go in a menu.
- Use progressive disclosure for advanced settings.
- URLs, reload, Back and Forward work together: a reloaded run URL opens that run.
- Reversible edits can be undone; irreversible ones explain their effect before a typed or
  explicit confirmation. Do not confirm routine actions.

## Carbon

- Use real Carbon components and icons and their size, kind and state props, not lookalikes.
- Follow Carbon's productive type scale, 2x Grid and spacing. Keep the root font at 16 px; get
  density from layout and component variants.
- Use local IBM Plex fonts; no runtime font requests.
- Use component tokens for surfaces, text, borders and states, scoped to their role. Do not
  restyle all buttons or inputs globally.
- Icon-only controls need an accessible name and a tooltip.
- No marketing heroes, ornamental borders, decorative gradients or captions under every control.

## The header rail

A project page's controls live in the header rail after the page name, through
`PageRail.svelte`:

```svelte
<PageRail target={rail} label={$t('findings.controls')} bind:search searchLabel={$t('findings.search')}>
  {#if narrow}<Button icon={Filter} iconDescription={…} …/>{:else}<Select inline hideLabel … />{/if}
  <span class="page-rail-end"><Button size="small" …>New finding</Button></span>
</PageRail>
```

- `App.svelte` lists rail pages in `railPages` and passes `rail` and `narrow` (760 px or less).
  Controls stay in the header at every width.
- Filters, view menus and actions come first; trailing actions go in `page-rail-end`. The page's
  main search ends the rail: an icon until opened, covering the bar on phones while open.
  `suggestions` and `onsearchkey` add a list of matches, as Lineage's run search does.
- On phones, buttons become icons and secondary controls move into a popover, so the header
  stays one row. Check the fit at 1056 px in French and Spanish and at 390 px.
- Rarely used lists (such as plan history) open in a modal from a rail button rather than taking
  page space.

## Run names

Show a run's name with `RunName.svelte` everywhere outside the runs table and run list:

```svelte
<RunName id={run.id} name={run.display_name} href={runURL(run)} onclick={…} />
```

- The run's colour swatch comes first (the project's run colours from `run-name.ts`, matching
  the charts), then the name on one line with an ellipsis; the full name shows on hover and on
  keyboard focus.
- Without `href` it is a button with `onclick`, or plain text with neither. `strong` suits
  headings; `quiet` gives a table link in body text colour.
- Places that draw runs themselves (the GPU timeline, chart legends) use the same colour from
  `run-colors.ts`.

## Run states

`RunStateTag.svelte` shows a run's state. Stopped runs (state `killed`) get a purple square;
only running runs get the animated running dot. Use the shared tag rather than restating
colours.

## Colour

- A neutral Carbon theme with one interaction accent; accent choices map to full sets of hover,
  active, focus and selected states.
- Error, warning, success and run colours stay separate; never recolour errors or series to the
  accent.
- Run colours follow W&B's light and dark palettes in both themes
  ([research notes](../history/wandb-reference.md#run-colors)).
- Contrast: 4.5:1 for text, 3:1 for large text and for control and focus indicators. Check the
  rendered colours in both themes, including hover, focus, pressed, selected, loading and error
  states.
- Never rely on colour alone: palette choices have names and a selected mark.

## Layout and accessibility

- Check Carbon breakpoints and the widths around them, 320 px, a narrow phone and 200% zoom,
  with long run names, large values and translated text.
- No page-level horizontal scrolling; a wide table may scroll inside a bounded box.
- Avoid nested scrolling: a panel inside a scrolling page fits its content or scrolls in one
  direction only.
- Targets at least 24×24 CSS px on desktop and 44–48 px for frequent touch actions; every drag
  has a tap alternative.
- Semantic headings, landmarks, labels, lists, tables and buttons; no click handlers on bare
  layout elements.
- Visible focus; test Tab, Shift+Tab, Enter, Space, arrows, Escape and focus return. Dialogs and
  drawers take initial focus, trap it where needed, close on Escape and return focus.
- Respect reduced motion; do not animate streaming charts to look busy.
- Loading, no data, no matches, disabled plugin and error are different states with different
  messages.

## Charts and experiment semantics

- Visibility and multi-solo selections are independent: solos override visibility and clearing
  them restores it. Dragging paints one state rather than toggling.
- X and Y values pair within the same history record; absent values are never zero.
- Name smoothing methods and their parameters accurately; raw and smoothed traces stay
  distinguishable.
- Downsampling keeps spikes (minimum and maximum per bucket); sampling extremes are not
  between-run spread. Aggregation states which runs contribute.
- Zoom fetches finer data rather than enlarging a coarse line.
- Hover is cheap: highlight by restyling or an overlay, never by redrawing every chart. The
  hovered run keeps its line width; the others dim.
- Work that a hover change makes slow (a panel redrawn for the hovered run) waits for the
  pointer to rest and never delays the highlight elsewhere; only the latest hover counts.
- Deliberate settings persist; an intentionally empty view stays empty after reload.

## Feedback and recovery

- Acknowledge accepted actions at once; distinguish saving, saved, unsaved and failed.
- Never silently overwrite a newer version from another client; refuse and let the user reload.
- Errors say what went wrong and what to do next, without credentials or stack traces. Keep
  the user's draft on recoverable errors.

## Writing

| Do                                                              | Don't                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------ |
| Lead with the task, outcome or fact.                            | Open with a welcome, praise or a summary of the next paragraph.    |
| Use familiar words, active verbs and one name per object.       | Use filler, superlatives or invented jargon.                       |
| Label actions by their effect: Create view, Export samples.     | Use generic Save or Continue where the effect is unclear.          |
| Keep labels short; add help only where it changes a decision.   | Add a subtitle, tooltip and helper paragraph to every field.       |
| State limitations and their consequences.                       | Hide missing features behind reassuring words.                     |
| Scope claims to evidence: tested SDK version, measured timings. | Say fully compatible, secure, instant or production-ready.         |
| Use precise units: records, steps, bytes, memory kinds.         | Call a record count the final step, or a JS heap the tab's memory. |
| Say when data leaves the machine (Assistant providers).         | Imply a model-connected feature keeps everything local.            |

## Localization

Interface text lives in `frontend/src/locales/`: `en`, `zh-Hans`, `zh-Hant` (Taiwan usage),
`ja`, `ko`, `fr` and `es`. Every catalog has the same keys and placeholders; `npm test` checks
parity, key names, unused keys and Taiwan wording.

- Name keys by place and meaning, in camelCase segments: `workspace.section.rename`,
  `panelSettings.axes.excludeOutliers.label`. No hyphens.
- One English word in two senses gets two keys (the Group button and a run's Group field).
- A key is never also the parent of other keys; use leaves such as `.label`, `.help`, `.title`.
- Plurals are siblings `name.one` and `name.other`; pass the base key and `count`.
- Write keys as string literals. Map identifiers to keys with a literal map
  (`Record<State, MessageKey>`), never by building key strings, so the type check and the
  unused-key test see every use.
- Show server, plugin, user and logged text with `{ text }`; it is never looked up.
- Server errors carry an English message and a code from `backend/src/management-errors.ts`;
  `apiMessages` in `frontend/src/api.ts` maps the code to a key. Add both for a new failure.
- Add each message to all seven catalogs, sorted, translated for its context. Keep product and
  technical tokens (W&B, SDK, API key, metric names, `${…}`) unchanged. Traditional Chinese uses
  Taiwan terms: 程式, 檔案, 資料, 設定, 預設, 執行, 伺服器, 網路, 介面, 帳號, 選單, 視窗, 物件,
  使用者, 列 for rows and 欄 for columns.
- Format numbers, dates and durations with the `number`, `date` and `duration` stores.
