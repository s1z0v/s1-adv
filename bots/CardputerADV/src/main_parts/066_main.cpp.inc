// Offline chess demo. No assets, SD writes, network requests or engine task.
namespace {
chess_demo::Game gChess;
uint16_t gChessAiIndex = 0;
int gChessAiBestScore = -32767;
chess_demo::Move gChessAiBest;
uint32_t gChessAiAfterMs = 0;
const char* gChessHint = "Pick a piece";

void chessDemoChanged() {
  gLastRenderMs = 0;
  gUiFramePolicy.invalidate();
}

void chessDemoResetAi() {
  gChessAiIndex = 0;
  gChessAiBestScore = -32767;
  gChessAiAfterMs = millis() + 250;
}

void beginChessDemo() {
  if (!gChess.started) { gChess.reset(); chessDemoResetAi(); }
  chessDemoChanged();
}

bool handleChessDemoKey(char key, const Keyboard_Class::KeysState& keys) {
  beginChessDemo();
  const char lower = static_cast<char>(tolower(static_cast<unsigned char>(key)));
  if (keys.ctrl || keys.alt || keys.opt) return true;
  if (lower == 'n') {
    gChess.reset(); chessDemoResetAi(); gChessHint = "New game";
  } else if (key == '\b' || keys.del) {
    gChess.selected = -1; gChessHint = "Pick a piece";
  } else if (lower == 'w' || key == ';') gChess.moveCursor(0, 1);
  else if (lower == 's' || key == '.') gChess.moveCursor(0, -1);
  else if (lower == 'a' || key == ',') gChess.moveCursor(-1, 0);
  else if (lower == 'd' || key == '/') gChess.moveCursor(1, 0);
  else if (key == '\r' || key == '\n' || key == ' ' || keys.enter) {
    if (gChess.outcome != chess_demo::Result::Playing) gChessHint = "N: new game";
    else if (gChess.position.turn != 1) gChessHint = "CPU thinking";
    else if (gChess.selected == gChess.cursor) {
      gChess.selected = -1; gChessHint = "Pick a piece";
    } else if (gChess.position.board[gChess.cursor] > 0) {
      gChess.selected = gChess.cursor; gChessHint = "Pick destination";
    } else if (gChess.selected >= 0 && gChess.play(gChess.selected, gChess.cursor)) {
      chessDemoResetAi(); gChessHint = "Move played";
    } else gChessHint = "Illegal move";
  }
  chessDemoChanged();
  return true;
}

void serviceChessDemo() {
  if (gUiMode != UiMode::Chess || gLauncherVisible || !gChess.started ||
      gChess.position.turn != -1 || gChess.outcome != chess_demo::Result::Playing ||
      gRecording || gSubmitting || gThinking || gPlaybackActive || gRealtimeActive ||
      gBlockingInputPumpActive || static_cast<int32_t>(millis() - gChessAiAfterMs) < 0) return;
  // Only four candidate evaluations per UI loop; voice, Escape and menu keep
  // their normal polling slots. There is no recursive search or heap workspace.
  for (int work = 0; work < 4 && gChessAiIndex < gChess.legal.count; ++work, ++gChessAiIndex) {
    const auto move = gChess.legal.moves[gChessAiIndex];
    const int score = chess_demo::moveScore(gChess.position, move);
    if (score > gChessAiBestScore) { gChessAiBestScore = score; gChessAiBest = move; }
  }
  if (gChessAiIndex == gChess.legal.count) {
    gChess.play(gChessAiBest.from, gChessAiBest.to);
    gChessHint = "Your move";
    chessDemoChanged();
  }
}

String chessDemoSquare(int square) {
  char text[3] = {char('a' + square % 8), char('1' + square / 8), '\0'};
  return String(text);
}

void renderChessDemoUi() {
  beginChessDemo();
  auto& d = gCanvas;
  const uint16_t bg = rgb565_local(8, 13, 22);
  const uint16_t light = rgb565_local(174, 189, 188), dark = rgb565_local(57, 80, 100);
  const uint16_t accent = rgb565_local(74, 238, 192), amber = rgb565_local(255, 191, 76);
  const uint16_t muted = rgb565_local(157, 174, 195), ink = rgb565_local(13, 20, 30);
  d.fillScreen(bg);
  d.setFont(&fonts::Font0);
  const char* letters = " PNBRQK";
  for (int square = 0; square < 64; ++square) {
    const int f = square % 8, r = square / 8, x = 8 + f * 14, y = 8 + (7 - r) * 14;
    const uint16_t tile = ((f + r) & 1) ? light : dark;
    d.fillRect(x, y, 14, 14, tile);
    if (gChess.hasLast && (gChess.last.from == square || gChess.last.to == square))
      d.drawRect(x + 1, y + 1, 12, 12, amber);
    const int piece = gChess.position.board[square];
    if (piece) {
      const uint16_t chip = piece > 0 ? TFT_WHITE : ink;
      d.fillRoundRect(x + 2, y + 2, 10, 10, 2, chip);
      d.setTextColor(piece > 0 ? ink : TFT_WHITE, chip);
      d.setCursor(x + 4, y + 3); d.print(String(letters[chess_demo::absPiece(piece)]));
    }
    if (gChess.selected >= 0 && gChess.legal.contains(gChess.selected, square)) {
      if (piece) d.drawRect(x + 1, y + 1, 12, 12, accent);
      else d.fillCircle(x + 7, y + 7, 2, accent);
    }
    if (square == gChess.selected) d.drawRect(x, y, 14, 14, accent);
    if (square == gChess.cursor) {
      d.drawRect(x, y, 14, 14, amber);
      d.drawRect(x + 1, y + 1, 12, 12, amber);
    }
  }
  // Coordinates remain outside the board and above the shared status bar.
  d.setTextColor(muted, bg);
  for (int f = 0; f < 8; ++f) { d.setCursor(12 + f * 14, 120); d.print(String(char('a' + f))); }
  for (int r = 0; r < 8; ++r) { d.setCursor(1, 11 + (7 - r) * 14); d.print(String(r + 1)); }
  d.setFont(&fonts::Font2); d.setTextColor(accent, bg);
  d.setCursor(132, 8); d.print("CHESS");
  d.setFont(&fonts::Font0); d.setTextColor(muted, bg);
  d.setCursor(132, 29); d.print("White vs CPU");
  const char* state = gChess.position.turn == 1 ? "YOUR MOVE" : "CPU THINKING";
  if (gChess.outcome == chess_demo::Result::WhiteWins) state = "YOU WIN!";
  else if (gChess.outcome == chess_demo::Result::BlackWins) state = "CPU WINS";
  else if (gChess.outcome == chess_demo::Result::Stalemate) state = "STALEMATE";
  else if (gChess.position.inCheck(gChess.position.turn)) state = gChess.position.turn == 1 ? "CHECK!" : "CPU IN CHECK";
  d.setTextColor(TFT_WHITE, bg); d.setCursor(132, 43); d.print(state);
  d.setTextColor(muted, bg); d.setCursor(132, 55);
  d.print(gChess.selected >= 0 ? chessDemoSquare(gChess.selected) + " > " + chessDemoSquare(gChess.cursor)
                             : "Cursor " + chessDemoSquare(gChess.cursor));
  d.setCursor(132, 67);
  d.print(gChess.hasLast ? "Last " + chessDemoSquare(gChess.last.from) + "-" + chessDemoSquare(gChess.last.to) : "Easy demo");
  d.setTextColor(amber, bg); d.setCursor(132, 79); d.print(fitCurrentFontToWidth(gChessHint, 102));
  d.setTextColor(muted, bg);
  d.setCursor(132, 91); d.print("WASD / arrows");
  d.setCursor(132, 101); d.print("Enter pick/move");
  d.setCursor(132, 111); d.print("Del undo pick");
  d.setCursor(132, 121); d.print("N new  Esc exit");
  renderLauncherOverlay();
  renderDebugOverlay();
}
} // namespace
