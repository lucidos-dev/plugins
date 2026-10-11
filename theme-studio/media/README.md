# Theme Studio

Theme Studio lets you make your own Lucidos themes. You pick colours, and Lucidos repaints around you while you work. When you like what you see, you save the theme and apply it.

## What it does

- **Start from any theme, or from scratch.** A built-in theme stays as it is, so Theme Studio makes a copy with a new id. Your own themes you edit in place.
- **Three seed colours do most of the work.** Set the background, the text and the accent. Lucidos derives the rest from them.
- **Override any design token.** Every other token is optional. Set a value for dark mode, light mode, or both.
- **Tune the header and focus cues.** Choose a flat or gradient header bar, the header text colour, the divider, and a focus wash or a focus underline.
- **Style named parts.** Give a part such as chat text, the composer or the icons its own colour, glow or letter-spacing. Each effect has a cap, and Lucidos owns every selector, so a part can never move, hide or cover anything.
- **Pick fonts.** Choose a UI font and a code font from the fonts your Lucidos ships.
- **Live preview.** Each edit repaints the whole Lucidos UI, on every open device. Save, Cancel or leaving the app puts your own look back.

## What it needs

- Lucidos 0.48.0 or later.
- Nothing else. No account, no API key and no setup step.

## Try this first

1. Open Theme Studio and pick a theme you already like under **Start from**.
2. Change the **accent** seed colour and watch Lucidos repaint.
3. Open **Header and focus** and try a gradient header.
4. Press **Save** to keep the theme as your own file, or **Save and apply** to switch to it now.

## Good to know

- Your themes are plain files at `themes/<id>.json` in your workspace. Lucidos checks each one when you save and tells you why it refuses a value.
- The live preview shows the mode Lucidos is in now. If you edit Light while Lucidos is dark, the specimen in the app shows the change, not the whole UI.
- If a device has its own theme or style overrides, those win on that device. The app tells you when this happens.
- If the UI ever stays in a preview colour, open Theme Studio once and it puts your own look back.

Theme Studio was called Look Studio before. Its two first themes, Ember and Harbour, now ship with Lucidos as built-in themes.
