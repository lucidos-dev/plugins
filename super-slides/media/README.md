# Super Slides

Super Slides turns a plain JSON file into a clean, themed slide deck. You describe the deck, Lucidos writes it, and you present it from the same workspace. Your phone can be the speaker remote.

## What it does

- **Decks from a description.** Ask Lucidos for a presentation. It writes a `.slides` file under `artifacts/presentations/`, and the app finds it on its own. The plugin ships a format guide, so Lucidos knows every component: headers, columns, pipelines, cards, takeaways and more.
- **A presentation chooser.** Tap the grid button to switch between decks. Every `.slides` file in the folder shows up there.
- **Sections and a slide picker.** Large decks can group slides into coloured sections. A title bar shows where you are, and you can jump to any slide.
- **Card focus.** On a slide with several cards, the arrow keys walk through the cards one at a time, so you can talk about each point in turn.
- **A speaker remote on your phone.** Turn on Remote mode on the phone and present from the laptop. The remote shows the slide title, what comes next, your notes and a talk timer. It stays in step with the presenter through Lucidos events. You can also edit the notes from the remote.
- **Optional Google Drive.** Save a deck to Drive, open one from Drive, and share it by link or by email. The app works fully without Drive.

## What it needs

- **Lucidos 0.48.0 or later.**
- **Nothing else for the core app.** No account or key.
- **Google Drive is optional.** It needs a connected Google account with full Drive access, plus one proxy entry. The setup thread after install walks you through both, but only if you ask for Drive.

## What to try first

1. Install the plugin. The setup thread offers to make a starter deck, so the app is never empty.
2. Open Super Slides and step through the deck with the arrow keys, or tap the slide.
3. Ask Lucidos: *"Make me a five slide deck about our trip to Lisbon."* The new deck shows up in the chooser.
4. Open Super Slides on your phone, tap the grid button, and pick **Remote mode**. Now move between slides from the phone while the laptop presents.

## Links you can share

The app reads its address hash, so you or Lucidos can link straight to a view:

- `#deck=<deck-id>&slide=3` opens a deck at slide 3.
- `#menu` opens the presentation chooser.
- `#remote` opens the speaker remote.

## Good to know

- Decks are plain files in your workspace. Lucidos can edit them, git keeps their history, and uninstalling the plugin never deletes them.
- The app keeps its resume position in `artifacts/super-slides/state.json`, so every device opens where you stopped.
- The screenshots use a made-up demo deck about a balcony herb garden. It does not ship with the plugin.
