---
name: Theme Studio, making themes in an app
description: How the Theme Studio app builds, previews, saves and applies Lucidos themes, and what to do when its live preview gets stuck or a save is refused. Load when the user mentions Theme Studio (formerly Look Studio), making a theme, a custom theme or look, their own colours, the header colour, focus underline, theme parts, a theme that will not save, or a font in a theme.
---

# Theme Studio

Theme Studio is an app for making themes. A theme is a JSON file of design-token
values at `data/themes/<id>.json`. The platform rules live in
`system-knowhow/themes`. Load that first for the token catalog, the part catalog
and the value rules.

## What the app does

- **Start from** any theme (built-in or the user's own) or from scratch. A
  built-in theme cannot change, so starting from one makes a copy with a new id.
  Starting from one of the user's themes edits it in place.
- **Seeds first.** `--bg-primary`, `--text-primary` and `--accent` are the big
  controls. The engine derives the rest from them. Every other token is an
  optional override.
- **Three scopes.** Dark, Light, and Both modes (the theme's `tokens` map). A
  dark or light value wins over Both modes.
- **Header and focus** has its own section: flat or gradient bar, header text
  colour, divider, and focus wash versus focus underline.
- **Parts** builds its controls from `GET /api/v1/themes/parts` and previews
  through `POST /api/v1/themes/resolve`, which writes nothing. Parts use the
  same three scopes and write `parts`, `dark.parts` or `light.parts`.
- **Save** writes `themes/<id>.json` with `lucidos.data.write`. The engine
  validates it and the app shows the refusal reason. **Save and apply** also
  sets the `theme` preference. **Delete** appears only for the user's own themes.

## Live preview

While the user edits, the app writes the draft's resolved tokens into the
**global** `style_overrides` preference, so every open client repaints. It
keeps the user's own overrides for tokens the draft does not paint, and marks
the map with `--theme-studio-preview`. Save, Cancel and leaving the pane put the
user's own map back. The original map is also saved at
`artifacts/theme-studio/preview-session.json`. If the pane closes mid-edit, the
next visit restores it.

**If the UI is stuck in a preview colour:**

1. Open Theme Studio once. It detects the marker and restores the saved map.
2. Or open Lucidos with `?style-reset` on the URL. That clears
   `style_overrides` before first paint.
3. Or set `style_overrides` to the `original` value in
   `artifacts/theme-studio/preview-session.json`, then delete that file.

## Known limits

- **A device-scoped `theme` or `style_overrides` wins.** The SDK cannot scope a
  write to the app's own device (ADR 0227 keeps the device id out of app
  frames). So Save and apply sets the global `theme`. If this device has its own
  theme picked, the app says so and links to Settings, Appearance, Theme.
- **The live preview shows the mode Lucidos is in.** Editing Light while
  Lucidos is dark updates the in-app specimen, not the whole UI.
- **Fonts.** The Fonts section writes the theme's `fonts` field by catalog id,
  from `GET /api/v1/fonts`. `fonts.ui` paints only on a device whose
  `font-family` is `theme` ("Follow the theme"), so a device with its own font
  pick keeps it. `fonts.mono` fills `--font-mono` everywhere. The pickers list
  only fonts marked `theme_nameable` (vendored or device fonts), never a CDN
  font. Picking a code font clears any `--font-mono` override, since the engine
  refuses a theme that sets both. The live preview carries the code font only;
  the UI font shows in the specimen, and across Lucidos after save and apply.
  On a Lucidos without the font catalog the section says so and hides.
