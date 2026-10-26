# Token Cost 0.7.0 release preparation

Prepared against the published 0.6.4 baseline and the live workspace history through the phone date-picker change on October 23, 2026. No push or screenshot recapture was performed.

## Release decisions

- **Version: 0.7.0.** Session drill-downs, Handoffs, share donuts, weekly bars and widget scope/session controls add user-facing capability.
- **Engine: `>=0.51.0`.** The new session and handoff telemetry is absent from `v0.50.5` and present on the inspected engine main. See the evidence below.
- **Setup revision: 2, unchanged.** Setup text and reason are unchanged. The existing schedules invoke the same shipped paths. Scripts create the new head and handoff artifacts on their next run. Nothing changed that setup installs outside `data/`, and no setup rerun is needed. This follows `system-knowhow/plugins.md`'s engine-floor and setup-revision rules.
- Work is committed locally on the assigned worktree branch, as required by the worktree workflow. Main is untouched. Publication requires the owner's approval.

## Engine-floor evidence

The comparison was `git diff v0.50.5 main` in the Lucidos source checkout. Links below pin the inspected main revision; the old-release links pin `v0.50.5`.

| Feature used | Plugin consumer | Engine evidence | Floor impact |
| --- | --- | --- | --- |
| `ContextCaptured.session`, stamped at append | [rollup session grouping](apps/token-cost/scripts/rollup.py#L749), [snapshot grouping](scripts/token-cost/thread_costs.py#L48), widget session rows and deduplication | [crates/lucidos-engine/src/engine/thread_events/event.rs:291](https://github.com/lucidos-dev/lucidos/blob/60248c2c32d230add5694bfd0d57237f93040124/crates/lucidos-engine/src/engine/thread_events/event.rs#L291) declares the optional ordinal; [crates/lucidos-engine/src/engine/event_bus/mod.rs:1389](https://github.com/lucidos-dev/lucidos/blob/60248c2c32d230add5694bfd0d57237f93040124/crates/lucidos-engine/src/engine/event_bus/mod.rs#L1389) stamps it; [crates/lucidos-engine/src/engine/session_scope.rs:15](https://github.com/lucidos-dev/lucidos/blob/60248c2c32d230add5694bfd0d57237f93040124/crates/lucidos-engine/src/engine/session_scope.rs#L15) defines opening kinds and ordinal counting. None of these additions exists in the old release. | Requires the upcoming 0.51.0 telemetry. Older captures remain valid and are grouped without a session. |
| `SessionStarted.continuity.kind` (`fresh`, `handoff`), checkpoint, progress and opening | [handoff event query](apps/token-cost/scripts/rollup.py#L1150), session numbering in `build_handoffs` | [crates/lucidos-engine/src/engine/thread_events/event.rs:573](https://github.com/lucidos-dev/lucidos/blob/60248c2c32d230add5694bfd0d57237f93040124/crates/lucidos-engine/src/engine/thread_events/event.rs#L573) adds continuity; [crates/lucidos-engine/src/engine/thread_events/session.rs:59](https://github.com/lucidos-dev/lucidos/blob/60248c2c32d230add5694bfd0d57237f93040124/crates/lucidos-engine/src/engine/thread_events/session.rs#L59) defines its wire fields. The field and continuity type are absent in the old release. | Requires 0.51.0 for same-thread successor sessions and warm/cold checkpoint comparisons. |
| `SessionHandedOff.opening`, checkpoint, progress, coding agent | [handoff event types](apps/token-cost/scripts/rollup.py#L1130) and `build_handoffs` | [crates/lucidos-engine/src/engine/thread_events/event.rs:609](https://github.com/lucidos-dev/lucidos/blob/60248c2c32d230add5694bfd0d57237f93040124/crates/lucidos-engine/src/engine/thread_events/event.rs#L609) defines the new event. The old release has only the successor-thread path. | Requires 0.51.0. |
| Keep-alive call identification from `PromptInjected.origin.reason.kind = cache_keep_alive` | [keep-alive predicate](apps/token-cost/scripts/rollup.py#L676), live anchors and session keep-alive line | [crates/lucidos-engine/src/engine/thread_events/actor.rs:125](https://github.com/lucidos-dev/lucidos/blob/v0.50.5/crates/lucidos-engine/src/engine/thread_events/actor.rs#L125) already defines the reason and wire constant. | Already present in 0.50.x; does **not** raise the floor. |
| Checkpoint name/progress/verdict, legacy successor thread, turn-idle marks | Handoff comparison and legacy chain support | [crates/lucidos-engine/src/engine/thread_events/event.rs:598](https://github.com/lucidos-dev/lucidos/blob/v0.50.5/crates/lucidos-engine/src/engine/thread_events/event.rs#L598) already has `HandoffCheckpointReached` with `name`, `progress`, `pays`; legacy `SuccessorThreadSpawned`, `SuccessorRequested` and `CodingAgentIdled` also exist in that tag. New floor-rung fields are not consumed. | Does not raise the floor. |
| SDK preferences, focus, ready/reveal, event paging, price table, data, threads, navigation, proxy and UI controls | Both apps | [packages/lucidos-sdk/src/ui.ts:891](https://github.com/lucidos-dev/lucidos/blob/v0.50.5/packages/lucidos-sdk/src/ui.ts#L891) has `ready`; [packages/lucidos-sdk/src/ui.ts:1016](https://github.com/lucidos-dev/lucidos/blob/v0.50.5/packages/lucidos-sdk/src/ui.ts#L1016) exports focus APIs; [packages/lucidos-sdk/src/events.ts:23](https://github.com/lucidos-dev/lucidos/blob/v0.50.5/packages/lucidos-sdk/src/events.ts#L23) has `before_event_id`; [packages/lucidos-sdk/src/index.ts:39](https://github.com/lucidos-dev/lucidos/blob/v0.50.5/packages/lucidos-sdk/src/index.ts#L39) exports the price table. Remaining calls were already used by 0.6.4. | No new SDK requirement beyond 0.50.x. |
| Shared control/label CSS and theme variables | Both apps | [crates/lucidos-engine/src/api/sdk_iframe_control_theme_parts.css:26](https://github.com/lucidos-dev/lucidos/blob/v0.50.5/crates/lucidos-engine/src/api/sdk_iframe_control_theme_parts.css#L26) includes shared controls; [crates/lucidos-app/src/styles/global/shared-components.css:454](https://github.com/lucidos-dev/lucidos/blob/v0.50.5/crates/lucidos-app/src/styles/global/shared-components.css#L454) includes label tones. New chart/session/calendar classes are defined locally. | No new shared-CSS requirement. |
| CLI `model-prices`, `data write`; database URL and existing event/summary columns | Rollup, snapshot and preserved migration/setup | [crates/lucidos-cli/src/main.rs:310](https://github.com/lucidos-dev/lucidos/blob/v0.50.5/crates/lucidos-cli/src/main.rs#L310) registers `model-prices`; [crates/lucidos-cli/src/main.rs:1628](https://github.com/lucidos-dev/lucidos/blob/v0.50.5/crates/lucidos-cli/src/main.rs#L1628) dispatches `data write`. Origin grouping uses existing summary columns, not a new CLI command. | No additional floor increase. |

**Release-cut uncertainty:** at inspection there was no `v0.51.0` tag and main's `RELEASE` file still said 0.50.5. The 0.51.0 floor is based on the stated release cut from main, not a claim that 0.51.0 is already published. If the release omits this telemetry or uses another version, the floor must follow that actual release. No 0.50.x tag contains all three required additions above.

## Ported files and merge policy

Each differing file was compared with the published plugin baseline and its matching pre-port workspace revision, then three-way merged. Final diffs against the live files retain the plugin-only migration and portability changes. Equal files were retained unchanged.

- `apps/token-cost/index.html`: session rows/spans/keep-alive line, Handoffs, first-paint catch-up styling, donut/hover/weekly bars, origin grouping, phone picker and header; removed Refresh and its handler.
- `apps/token-cost/scripts/rollup.py`: origin classification, session-aware grouping/deduplication, session spans, handoff artifacts and output formatting. Migration still runs before price-table reads.
- `apps/thread-cost/manifest.json`: description now matches optional sub-thread scope and session rows; plugin ownership is preserved.
- `apps/thread-cost/index.html`: scope control, session rows, head-first paint, layout changes. Preserved unpriced warnings; supports plugin unpriced-only, workspace session-only and combined compact snapshot formats.
- `scripts/token-cost/thread_costs.py`: per-session snapshot and lightweight head, retaining migration, required environment validation, local timezone, empty-workspace safety and unpriced counts.
- Workspace regressions merged into `accounting.test.mjs`, `markup.test.mjs` and `rollup.test.py`. Plugin fixture/portability fixes in the other shared tests remain intact.
- Additional regressions in `freshness.test.mjs`, `thread-cost.test.mjs` and `snapshot.test.py` cover capped first paint, session boundaries, compact row compatibility, head fallback and head completeness.

Also retained unchanged: `scripts/token-cost/migrate_prices.py`, both fake engines, `migrate.test.py`, `upgrade.test.mjs`, legacy/shipped-price fixtures and the complete test runner. The plugin app README was retained and updated. The snapshot and widget tests were extended rather than replaced.

A port-related accounting fix scopes the widget and snapshot's Claude Code frame deduplication to an agent session, matching the new dashboard and rollup. Otherwise identical usage on the first call after a handoff could disappear. Tests pin that boundary. The accounting and freshness suites now use synthetic initial rollups instead of reading the developer's live workspace.

## Excluded content and privacy/dependency audit

- Excluded `apps/token-cost/knowhow/`, including the obsolete daily price-check instructions.
- Excluded workspace-only `apps/token-cost/scripts/auto_compact_trial.py` and `apps/token-cost/tests/auto_compact_trial.test.py`; no trial code is referenced by shipped code or the runner.
- Excluded all `__pycache__` and bytecode.
- Kept the plugin's `origin_plugin_id`; did not copy the workspace widget manifest's private `origin_thread_id`.
- Kept required workspace/database environment checks instead of the live snapshot's developer-workspace fallback and fixed timezone.
- Removed a workspace-only `knowhow/script-state-paths.md` reference and historical real-workspace usage counts from comments. No absolute developer paths, private workspace names, real thread titles/identifiers or actual cost totals were introduced. Test amounts/titles are synthetic; fixture model prices are public rates, not usage totals.
- Artifact references point to files the shipped rollup/snapshot/migration generate, or to supported optional UI/settings files. SDK/CSS/CLI references are engine-provided. The Frankfurter proxy entry remains explicitly installed by setup; `model-price-check` is engine-provided. No reference to an excluded trial or knowhow file remains.

## Verification

`env -u LUCIDOS_WORKSPACE PYTHONDONTWRITEBYTECODE=1 bash token-cost/apps/token-cost/tests/run.sh` runs every shipped suite, with no skips. **879 assertions passed, 0 failed across all 10 suites:** accounting 325, freshness 30, save 50, defaults 13, markup 42, upgrade 23, thread-cost 19, rollup 226, migrate 130, snapshot 21. Tests execute app scripts with DOM/SDK fakes; rollup SQL is exercised using SQLite and script integration uses a fake engine/psql. No live database is written and no browser screenshot test is claimed.

Manifest TOML and both app JSON manifests are parsed; setup text/revision/reason are compared byte-for-byte with 0.6.4; plugin-only files and excluded paths are checked; `git diff --check` is clean.

## Screenshots

All existing screenshots are stale: `media/dashboard.png`, `media/analysis.png`, `media/thread-cost-widget.png`, and `media/settings.png`. Reasons and capture guidance are in [media/README.md](media/README.md#screenshots-awaiting-recapture). The Handoffs view also needs a new screenshot. Images were not recaptured or changed.
