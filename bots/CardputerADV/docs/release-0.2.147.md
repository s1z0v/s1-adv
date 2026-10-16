# 0.2.147-dev — publish the missing procedural eye skins

The owner asked whether the previously described smooth eyes / six skins had
actually shipped, and authorized release if absent. Live manifest at inspection
was 0.2.146-dev (`01b611d`, SHA256
`7e64a8eed6d02a8766075873d335ef8675f591daee4e74fad500e99142c1ac28`).
Its renderer still used photographic tables; 0.2.145 fixed their byte order, not
the visual design. The procedural implementation existed only on the separate
`8623677` eye-skins branch and was not in the current release's ancestry.

This release ports only those eye/settings changes onto 0.2.146 / `5f7d637`:

- Big Eyes and the existing Big Eyes screensaver share procedural primitives.
- Black, Cat, Tiger, Leopard, Lion and Rabbit; default Black.
- Actual launcher path: **Device → Display → Eye skin** (screen title:
  Screensaver). Set **Saver style → Big Eyes** to use the same skin when idle.
- Eye skin is saved under the additive `eye_skin` Preferences key, clamped on
  load. Existing screensaver keys and values are retained.
- Retains blink, existing emotion/face-mode inputs and IMU gaze. Adds a small
  closing-eyelid clamp so the iris/pupil cannot protrude vertically.
- Palette checked at native 240×135 and the existing RGB332 canvas depth;
  neutral cat and cyan iris adjusted to avoid missing blue after quantization.
- Removes 158336 bytes of compiled bitmap tables and the 1920-byte eye strip.
  The shared 8-bit UI framebuffer is unchanged; no extra image/frame buffers.

Realtime, ordinary voice, audio drivers, transport, pacing, main loop, inbox and
OTA runtime logic are unchanged from 0.2.146. No Bridge source/service deploy,
no USB flash. The 0.2.146 binary/manifest remain the rollback baseline.

Validation:

- `scripts/ui_feature_smoke.py`: six skin labels, settings persistence wiring,
  screensaver lifecycle, no bitmap buffers, existing keyboard/inbox fences.
- `tests/render_eye_skins.mjs`: compiles the actual firmware eye functions;
  15360 geometry combinations, all six skins, blink/millis wrap, bounded draw
  calls, neutral color quantization, native-size RGB332 raster previews.
  Host primitives approximate rasterization; this does not prove TFT timing.
- Existing Realtime state (11 scenarios), actual launcher/mic wiring, microphone
  meter (256 width + 1280 age/mode cases), shortcut (43 checks), release delivery
  and battery/chime (18564 power boundaries) checks pass.
- Canonical wrapper build; exact artifact/hash/OTA outcome recorded in
  `adv_cardputer/output/cardputer-0.2.147/RELEASE.md` after publication.

Hardware animation/appearance and installed-version confirmation require the
owner/device. A queued command or download is not a confirmed installation.
