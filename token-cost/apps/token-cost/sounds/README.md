# Ring sounds

Every clip the Token Cost dashboard can play when a live model call lands. All
of them are public domain or synthesized here, so the app ships them with no
licence obligation on anyone who installs the plugin.

Processing is the same for all of the recorded ones: trimmed to the part that
carries the sound, 4ms fade in, 90ms fade out so neither edge clicks, peak
normalised to 0.89, downsampled to 22.05kHz and encoded AAC at 48kbps mono.
Per-sound loudness is evened out in the app (`SOUNDS[].gain` in index.html),
because peak normalising alone does not: a dense register hit reads much louder
than one bright coin at the same peak.

| File | Sound | Length | Size | Source | Licence |
|---|---|---|---|---|---|
| `register.m4a` | Cash register | 1.60s | 12.3 KB | [Commons: Cash register.ogg](https://commons.wikimedia.org/wiki/File:Cash_register.ogg), originally SoundBible 333 | Public domain, attribution not required |
| `arcade.m4a` | Arcade coin | 0.67s | 6.5 KB | Synthesized for this app, see below | None, generated here |
| `coinbox.m4a` | Coin in the tin | 0.95s | 9.5 KB | [Commons: Coins dropped in metallic moneybox.ogg](https://commons.wikimedia.org/wiki/File:Coins_dropped_in_metallic_moneybox.ogg) by ezwa | Public domain |

The ezwa recording is several seconds long and contains a run of separate hits;
the one here is a single hit cut out of that run (1.15s-2.10s of the original).

Two more ezwa clips shipped in v0.1.7 and were cut in v0.1.8 for sounding bad
rather than for any licence reason: `coindrop` (Coin dropped on wooden floor)
and `palm` (Shaking coins in palm). Both are public domain if they are ever
wanted back.

Note on fetching these from Commons: the ezwa `.ogg` originals are Ogg Skeleton
v4.0 containers that libsndfile and afconvert both refuse. Commons' own
transcoded MP3 renditions decode fine, so those are what the pack was built
from: `https://upload.wikimedia.org/wikipedia/commons/transcoded/<path>.ogg/<file>.ogg.mp3`.

## arcade.m4a

Not a recording of anything. Two band-limited square waves (harmonics 1 through
11), a 75ms grace note at B5 (987.77Hz) stepping up to a 600ms E6 (1318.51Hz)
with an exponential ring-down, phase-continuous across the step. That two-note
rising shape is the arcade coin-pickup convention rather than any one game's
sound, and synthesizing it avoids sampling a copyrighted game.

## Adding another built-in

Add the file here, add a row to `SOUNDS` in `index.html` (id, label, note, file,
gain), add a 24x24 stroke icon under the same id in `SOUND_ICONS`, and record
its provenance in the table above. Anything a user picks themselves is uploaded
to `artifacts/imported/` instead and never lands in this folder.
