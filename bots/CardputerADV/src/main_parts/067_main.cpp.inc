// Small offline checkers app; no persistent storage or network activity.
namespace {
checkers_demo::Game gCheckers;
uint8_t gCheckersAiIndex = 0;
int gCheckersAiBestScore = -32767;
checkers_demo::Move gCheckersAiBest;
uint32_t gCheckersAiAfterMs = 0;
const char* gCheckersHint = "Pick a piece";

void checkersDemoChanged() {
  gLastRenderMs = 0;
  gUiFramePolicy.invalidate();
}
void checkersDemoResetAi() {
  gCheckersAiIndex = 0; gCheckersAiBestScore = -32767;
  gCheckersAiAfterMs = millis() + 220;
}
void beginCheckersDemo() {
  if (!gCheckers.started) { gCheckers.reset(); checkersDemoResetAi(); }
  checkersDemoChanged();
}
bool handleCheckersDemoKey(char key, const Keyboard_Class::KeysState& keys) {
  beginCheckersDemo();
  const char lower = static_cast<char>(tolower(static_cast<unsigned char>(key)));
  if (keys.ctrl || keys.alt || keys.opt) return true;
  if (lower == 'n') {
    gCheckers.reset(); checkersDemoResetAi(); gCheckersHint = "New game";
  } else if (key == '\b' || keys.del) {
    gCheckers.selected = gCheckers.forced;
    gCheckersHint = gCheckers.forced >= 0 ? "Finish jump" : "Pick a piece";
  } else if (lower == 'w' || key == ';') gCheckers.moveCursor(0, 1);
  else if (lower == 's' || key == '.') gCheckers.moveCursor(0, -1);
  else if (lower == 'a' || key == ',') gCheckers.moveCursor(-1, 0);
  else if (lower == 'd' || key == '/') gCheckers.moveCursor(1, 0);
  else if (key == '\r' || key == '\n' || key == ' ' || keys.enter) {
    if (gCheckers.outcome != checkers_demo::Result::Playing) gCheckersHint = "N: new game";
    else if (gCheckers.turn != 1) gCheckersHint = "CPU thinking";
    else if (gCheckers.selected == gCheckers.cursor && gCheckers.forced < 0) {
      gCheckers.selected = -1; gCheckersHint = "Pick a piece";
    } else if (gCheckers.board[gCheckers.cursor] > 0) {
      if ((gCheckers.forced < 0 || gCheckers.cursor == gCheckers.forced) && gCheckers.legal.fromSquare(gCheckers.cursor)) {
        gCheckers.selected = gCheckers.cursor; gCheckersHint = "Pick destination";
      } else gCheckersHint = gCheckers.forced >= 0 ? "Finish jump" : "Pick legal piece";
    } else if (gCheckers.selected >= 0 && gCheckers.play(gCheckers.selected, gCheckers.cursor)) {
      checkersDemoResetAi();
      gCheckersHint = gCheckers.forced >= 0 ? "Jump again" : "Move played";
    } else gCheckersHint = gCheckers.captureRequired() ? "Capture required" : "Illegal move";
  }
  checkersDemoChanged();
  return true;
}
void serviceCheckersDemo() {
  if (gUiMode != UiMode::Checkers || gLauncherVisible || !gCheckers.started ||
      gCheckers.turn != -1 || gCheckers.outcome != checkers_demo::Result::Playing ||
      gRecording || gSubmitting || gThinking || gPlaybackActive || gRealtimeActive ||
      gBlockingInputPumpActive || static_cast<int32_t>(millis() - gCheckersAiAfterMs) < 0) return;
  // Four legal candidates per loop; do not block keyboard/voice polling.
  for (int work = 0; work < 4 && gCheckersAiIndex < gCheckers.legal.count; ++work, ++gCheckersAiIndex) {
    const auto move = gCheckers.legal.moves[gCheckersAiIndex];
    const int score = checkers_demo::moveScore(gCheckers, move);
    if (score > gCheckersAiBestScore) { gCheckersAiBestScore = score; gCheckersAiBest = move; }
  }
  if (gCheckersAiIndex == gCheckers.legal.count) {
    gCheckers.play(gCheckersAiBest.from, gCheckersAiBest.to);
    checkersDemoResetAi(); // each leg of a CPU multi-jump gets its own UI slice
    gCheckersHint = gCheckers.turn == 1 ? "Your move" : "CPU jumping";
    checkersDemoChanged();
  }
}
String checkersDemoSquare(int square) {
  char text[3] = {char('a' + square % 8), char('1' + square / 8), '\0'};
  return String(text);
}
void renderCheckersDemoUi() {
  beginCheckersDemo();
  auto& d = gCanvas;
  const uint16_t bg = rgb565_local(8, 13, 22), ink = rgb565_local(13, 20, 30);
  const uint16_t light = rgb565_local(174, 189, 188), dark = rgb565_local(57, 80, 100);
  const uint16_t accent = rgb565_local(74, 238, 192), amber = rgb565_local(255, 191, 76);
  const uint16_t red = rgb565_local(231, 65, 83), muted = rgb565_local(157, 174, 195);
  d.fillScreen(bg); d.setFont(&fonts::Font0);
  for (int square = 0; square < 64; ++square) {
    const int f = square % 8, r = square / 8, x = 8 + f * 14, y = 8 + (7 - r) * 14;
    const uint16_t tile = ((f + r) & 1) ? light : dark;
    d.fillRect(x, y, 14, 14, tile);
    if (gCheckers.hasLast && (gCheckers.last.from == square || gCheckers.last.to == square))
      d.drawRect(x + 1, y + 1, 12, 12, amber);
    const int piece = gCheckers.board[square];
    if (piece) {
      const uint16_t chip = piece > 0 ? red : ink;
      d.fillCircle(x + 7, y + 7, 5, chip);
      d.drawCircle(x + 7, y + 7, 5, piece > 0 ? amber : muted);
      if (checkers_demo::magnitude(piece) == 2) {
        d.setTextColor(TFT_WHITE, chip); d.setCursor(x + 4, y + 3); d.print("K");
      }
    }
    if (gCheckers.selected >= 0 && gCheckers.legal.contains(gCheckers.selected, square))
      d.fillCircle(x + 7, y + 7, 2, accent);
    if (square == gCheckers.selected) d.drawRect(x, y, 14, 14, accent);
    if (square == gCheckers.cursor) {
      d.drawRect(x, y, 14, 14, amber); d.drawRect(x + 1, y + 1, 12, 12, amber);
    }
  }
  d.setTextColor(muted, bg);
  for (int f = 0; f < 8; ++f) { d.setCursor(12 + f * 14, 120); d.print(String(char('a' + f))); }
  for (int r = 0; r < 8; ++r) { d.setCursor(1, 11 + (7 - r) * 14); d.print(String(r + 1)); }
  d.setFont(&fonts::Font2); d.setTextColor(accent, bg);
  d.setCursor(132, 8); d.print("CHECKERS");
  d.setFont(&fonts::Font0); d.setTextColor(muted, bg);
  d.setCursor(132, 29); d.print("Red vs CPU");
  const char* state = gCheckers.turn == 1 ? "YOUR MOVE" : "CPU THINKING";
  if (gCheckers.outcome == checkers_demo::Result::RedWins) state = "YOU WIN!";
  else if (gCheckers.outcome == checkers_demo::Result::BlackWins) state = "CPU WINS";
  else if (gCheckers.forced >= 0) state = "MULTI-JUMP";
  else if (gCheckers.captureRequired()) state = "MUST CAPTURE";
  d.setTextColor(TFT_WHITE, bg); d.setCursor(132, 43); d.print(state);
  d.setTextColor(muted, bg); d.setCursor(132, 55);
  d.print(gCheckers.selected >= 0 ? checkersDemoSquare(gCheckers.selected) + " > " + checkersDemoSquare(gCheckers.cursor)
                                : "Cursor " + checkersDemoSquare(gCheckers.cursor));
  d.setCursor(132, 67);
  d.print(gCheckers.hasLast ? "Last " + checkersDemoSquare(gCheckers.last.from) + "-" + checkersDemoSquare(gCheckers.last.to) : "K = king");
  d.setTextColor(amber, bg); d.setCursor(132, 79); d.print(fitCurrentFontToWidth(gCheckersHint, 102));
  d.setTextColor(muted, bg);
  d.setCursor(132, 91); d.print("WASD / arrows");
  d.setCursor(132, 101); d.print("Enter pick/move");
  d.setCursor(132, 111); d.print("Del undo pick");
  d.setCursor(132, 121); d.print("N new  Esc exit");
  renderLauncherOverlay(); renderDebugOverlay();
}
} // namespace
