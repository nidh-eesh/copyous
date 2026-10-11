# GNOME 51 opening performance investigation

Date: 2026-10-11

## Confirmed causes

1. Opening an eight-card window automatically requested two more pages before any scrolling. The old prefetch threshold included a whole viewport, so a nearly full initial page was already considered close to the end. Each repeated opening created sixteen unnecessary actors and reached twenty-four cards.
2. Reconciliation removed and reinserted every retained actor, even when its position had not changed. This discarded mapped rendering state and caused additional layout work.
3. Every card used an offscreen shader, including the normal header layout where the buttons do not overlap the content.
4. Initial focus scrolled to the first card even though mapping had already reset the position. The allocation query forced expensive synchronous layout before the opening animation could proceed.
5. Text and code previews passed the full entry to Pango and syntax highlighting. A generated large entry reproduced a two-second opening stall. The real history was inspected only for type counts and content lengths, which confirmed that similarly sized entries exist. Actual clipboard contents were not copied into tests or reports.

## Repairs

- Paging is disabled during the opening animation and while closed. Once open, the initial window expands if necessary to fill the viewport; otherwise the next page waits for scrolling or keyboard navigation.
- Retained actors stay attached. Reordering uses the native child-index operation only when the order changes.
- The content mask is created only for the hidden-header layout and disabled when the header is shown.
- Initial keyboard focus goes directly to the first card without scrolling to zero again.
- Deferred preview loading starts after the opening animation completes. A close or destroy cancels the opening path.
- Card display text is bounded to 4,096 UTF-16 code units and 64 lines before indentation, syntax highlighting, and native layout. A truncation marker follows the preview. Surrogate pairs remain intact. The complete entry and source label properties are retained for copying, searching, editing, and accurate information counts.

## Measurements

The profiler runs in a separate GNOME Shell 51 with a private D-Bus session, disposable settings and history, the default GBM renderer, a 1600 by 900 virtual monitor, and generated fixtures. It observes stage paint callbacks and a 5 ms event-loop heartbeat. Continuous redraw is requested for the first 250 ms so idle frames do not appear as stalls. Each case contains one cold opening and eleven repeated openings.

The baseline uses the actual `4462ab0` release ZIP. The revised release uses the same fixture and harness. Runs are sequential. Warm results below are medians across the eleven repeated openings.

| Metric                                              |  Baseline |  Revised |
| --------------------------------------------------- | --------: | -------: |
| First visible stage paint, warm                     |   49.1 ms |  23.1 ms |
| Longest frame gap per opening, warm                 |   42.1 ms |  18.0 ms |
| Longest event-loop heartbeat gap, warm              |   16.3 ms |   6.8 ms |
| Longest stage paint callback interval, warm         |   11.1 ms |   2.3 ms |
| Cards after opening without scrolling               |        24 |        8 |
| First visible stage paint, cold                     |  239.8 ms | 116.9 ms |
| First visible stage paint, cold large-entry fixture | 2222.7 ms | 162.6 ms |

Disabling pagination alone reduced the warm longest frame gap from about 42 ms to 19 ms. Disabling the content mask alone left it near 41 ms. This identifies automatic actor creation as the main repeated-opening problem. The remaining changes reduce layout and painting cost and address the large-entry case.

These are instrumented headless stage-paint observations, not hardware presentation timestamps or a guarantee of identical desktop latency. Cold samples are individual observations and include first-use layout and resource preparation. Some first-use cost remains. Baseline and revised logs also contain existing Clutter allocation warnings, so the investigation does not claim that every framework warning is eliminated.

## Regression coverage

The native suite additionally checks:

- Initial eight-card bounds in both orientations.
- A taller viewport with short cards automatically filling with another page.
- Actual scroll adjustment changes loading more cards.
- Initial keyboard focus and keyboard selection of a paged card.
- Reordering retained actors without unmapping them.
- Visible text and code pixels with both normal and hidden headers.
- All eight card types, indexed archive search, persistence failure and recovery, editor menus, repeated open/page/close, and disable/enable/disable while open.
- Large text and code preview bounds while complete source properties and entry contents remain intact.
- Optional shader initialization failure retaining visible contents.

The native suite is run at 1920 by 1080 with the default renderer, matching the supplied desktop screenshot dimensions. A separate software-renderer run exercises the shader fallback.

## Reproduce

```sh
RELEASE=1 make build
make test
pnpm lint
python scripts/tests/gnome-shell-smoke.py --default-renderer --monitor=1920x1080
python scripts/tests/gnome-shell-smoke.py --mask-failure
python scripts/tests/gnome-shell-smoke.py --default-renderer --profile=optimized
python scripts/tests/gnome-shell-smoke.py --default-renderer --profile=optimized-large
python scripts/tests/gnome-shell-smoke.py --default-renderer --profile=baseline --package=/path/to/4462ab0.zip
```

Diagnostic profile names can include `nopaging`, `noeffect`, `nopreview`, `noscale`, or `hidden` to isolate specific costs. These switches only modify the disposable Shell process.

## Applying an installed update

The current Wayland Shell retains imported JavaScript modules. Disabling and enabling an already loaded extension does not load edited modules. The installed Shell rejects its deprecated extension reload call. Installing the package updates the files for the next Shell session; a logout/login or reboot is required to activate the revised code in this session. The installer does not end the user's session.
