# GNOME 51 crash and rendering investigation

Date: 2026-10-11

## Confirmed cause

The installed GNOME 51 package crashed the compositor when the first card was painted. The journal records an invalid positional `new Cogl.Snippet(...)` constructor call immediately before segmentation faults in `cogl_snippet_get_capability`. Core dumps for Shell processes 4993 and 9110 confirm the same native call chain. Because Shell is the Wayland compositor, the crash ends the graphical session. GNOME's crash recovery then disables user extensions.

The earlier checks established that the extension could initialize, but did not execute the native paint callback. That was insufficient validation. Shell's ACTIVE state and an empty extension error list do not establish that card rendering is safe.

The installed GNOME 51 GIR files and Shell's own `ui/lightbox.js` were used to establish the actual API contracts:

- Construct snippets with `Cogl.Snippet.new(hook, declarations, post)`.
- `get_static_snippet` returns a non-null snippet with full transfer ownership.
- `OffscreenEffect.paint_target` receives a paint node and paint context and returns void.
- `ShaderEffect.set_uniform_float` receives a uniform name, component count, and values array in GJS.

## Findings and repairs

| Severity | Finding                                                               | Evidence and repair                                                                                                                                                                                                                                                        |
| -------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical | Invalid snippet construction from a native callback                   | Journal and core dumps confirm the crash. The correct constructor now runs before class registration. The native callback only returns the validated object. Initialization failure disables the optional mask and leaves card contents visible.                           |
| High     | Incorrect paint chaining and misleading effect types                  | The prior code omitted required arguments, then treated the return as a boolean. The implementation now derives its types from `Clutter.OffscreenEffect`, passes both paint arguments, returns void, and chains with `super`.                                              |
| Medium   | Deferred previews accessed destroyed cards                            | Repeated searches reproduced native disposed-object warnings. Card destruction now removes its queued preview job. Dialog teardown rejects later refresh work.                                                                                                             |
| Medium   | Teardown left menus, adjustment handlers, and pending callbacks alive | Native disable/enable tests reproduced disposed adjustment warnings and leaked menus. Explicit cleanup now releases modal grabs, cancels animation and idle work, disconnects adjustments, destroys owned cards and menus, and guards search unmapping during destruction. |
| Medium   | Async action configuration could update a destroyed menu              | Native lifecycle tests reproduced updates into disposed popup actors. Destruction and request serial checks now discard late configuration results.                                                                                                                        |
| Medium   | Text-card signal connection lacked its owner                          | The journal repeatedly reported `No object to track signals`. The content notification now supplies the card owner and is disconnected with the card.                                                                                                                      |
| Medium   | Closing the editor leaked its language popup                          | The native editor test observed an undestroyed language menu after close. The editor now explicitly destroys its language button and associated menu.                                                                                                                      |
| Low      | Deprecated button-mask names emitted repeated warnings                | GNOME 51 warning logs identified ONE, TWO, and THREE. Compatibility helpers now use PRIMARY, MIDDLE, and SECONDARY on 51, retaining the old aliases on earlier supported versions.                                                                                         |

Storage warning translations also now import the extension's gettext function explicitly. Shell already supplies a global translation function, so the repository scan's other global gettext matches were not classified as crash causes.

## Review coverage

The complete GNOME 51 migration diff from commit `1a16585` was reviewed. The current implementations of the following files were read in full while tracing construction, painting, deferred work, and teardown:

- `resources/metadata.json`
- `Makefile`
- `src/extension.ts`
- `src/lib/database/database.ts`
- `src/lib/database/entryTracker.ts`
- `src/lib/database/persistenceQueue.ts`
- `src/lib/database/store.ts`
- `src/lib/misc/compatibility.ts`
- `src/lib/misc/keyboard.ts`
- `src/lib/misc/popupMenu.ts`
- `src/lib/ui/clipboardDialog.ts`
- `src/lib/ui/clipboardScrollContainer.ts`
- `src/lib/ui/clipboardScrollView.ts`
- `src/lib/ui/searchEntry.ts`
- `src/lib/ui/items/clipboardItem.ts`
- `src/lib/ui/items/textItem.ts`
- `src/lib/ui/components/holeEffect.ts`
- `src/lib/ui/components/actionMenu.ts`
- `src/lib/ui/components/clipboardItemMenu.ts`
- `src/lib/ui/components/editDialog.ts`
- `scripts/tests/gnome-shell-smoke.py`
- `scripts/tests/gnome-shell-smoke.mjs`

A repository-wide TypeScript AST scan checked 90 source files, 46 tracked signal calls, and 62 virtual method declarations. Exact and generalized searches found one positional Cogl snippet construction and one two-argument tracked signal connection. Both confirmed instances were repaired. The older GLSL effect is reachable only on older Shell versions. All direct popup animation calls in the migration use the compatibility adapter.

### Checklist for the reviewed paths

| Check                  | Result                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Injection              | Clipboard strings remain label data. User-configured shell commands intentionally receive clipboard input through stdin and positional arguments. No new interpolation or command execution was introduced. |
| XSS and markup         | Text cards use plain labels. Code highlighting and its existing markup path were exercised with the bundled highlighter. No web HTML output was introduced.                                                 |
| Authentication         | Not applicable to native card rendering. No account or credential flow changed.                                                                                                                             |
| Authorization and IDOR | No new external or privileged access was added.                                                                                                                                                             |
| CSRF                   | Not applicable to the reviewed native extension interfaces.                                                                                                                                                 |
| Races                  | Confirmed preview, action-menu, and teardown races were repaired and exercised in isolated Shell tests.                                                                                                     |
| Session state          | Open/close and disabling while open now release modal grabs. Owned menu destruction is asserted.                                                                                                            |
| Cryptography           | No cryptographic operation changed.                                                                                                                                                                         |
| Information disclosure | Test data is generated. Timing reports contain counts and durations rather than clipboard contents.                                                                                                         |
| Resource exhaustion    | Error loops were removed. The native fixture verifies 500-entry hydration from a 520-entry archive and repeatedly pages and closes the UI.                                                                  |
| Business logic         | Native tests cover content updates, archive search, and actual persistence retry after an injected failure. Existing persistence and SQLite suites also pass.                                               |

## Native validation

`make test-shell` launches a separate headless GNOME Shell with a private D-Bus session, temporary runtime/configuration/data/cache/state directories, memory-backed settings, and generated clipboard fixtures. It extracts the actual extension ZIP. The test highlighter is bundled from the repository's installed development dependency. The desktop's real clipboard database is not used by this test.

The test covers:

- 520 SQLite entries, bounded 500-entry hydration, and indexed retrieval of an older archive item.
- All eight card types, visible and hidden headers, and both layout orientations.
- Non-null native snippets and actual text/code pixels in screenshots.
- A real tracker write failure, exactly one warning, retry, and successful persistence.
- Text updates, item menus, the code editor, and its language menu.
- Twenty repeated open, page, and close cycles.
- Disable, enable, repaint, and disable while open, with modal and menu cleanup assertions.

The runner fails on GJS errors, native disposed-object criticals, shader warnings, missing signal owners, or unexpected mask fallback. A separate `--mask-failure` run injects a snippet construction error and verifies that content remains visible and the warning occurs once.

The normal software renderer run and the default renderer run passed. The default renderer's log confirms GBM devices for NVIDIA and Intel, with Intel selected as the primary GPU. The default run captured 1,082 bright text-content pixels and 338 bright code-content pixels. Repeated warm opening completion was sampled at approximately 56 ms median, including the animation and a 50 ms polling interval; this is a regression observation rather than a precise frame benchmark.

Reproduce after building:

```sh
make test
make test-shell
python scripts/tests/gnome-shell-smoke.py --default-renderer
python scripts/tests/gnome-shell-smoke.py --mask-failure
```

For final package verification, use `RELEASE=1 make clean build` first and then run the same native tests against that release ZIP.

## Limits and separate system observations

GNOME 48 through 50 are retained by the conditional legacy implementation but were not available for native runtime tests on this machine. GTK preferences, arbitrary user action commands, and every possible file/network preview input were not exhaustively tested. The crash investigation and native regressions cover the GNOME 51 migration and opening/rendering/lifecycle paths described above.

The system journal separately reports a missing `libecal-2.0.so.3` for the calendar server. That failure is outside Copyous and is not on the confirmed compositor crash stack.
