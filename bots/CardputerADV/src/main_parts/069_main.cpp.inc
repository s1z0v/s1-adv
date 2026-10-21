// Classic beginner Minesweeper, fully offline and independent of SD/EXT.
namespace {
minesweeper::Game gMinesweeper;
uint16_t gMinesweeperLastSecond = 1000;

void minesweeperChanged() {
  gLastRenderMs = 0;
  gUiFramePolicy.invalidate();
}
void newMinesweeperGame() {
  gMinesweeper.reset(esp_random());
  gMinesweeperLastSecond = 1000;
  minesweeperChanged();
}
void beginMinesweeper() {
  if (!gMinesweeper.initialized) newMinesweeperGame();
  minesweeperChanged();
}
void serviceMinesweeper() {
  if (gUiMode != UiMode::Minesweeper || !gMinesweeper.initialized) return;
  const uint16_t second = gMinesweeper.seconds(millis());
  if (second != gMinesweeperLastSecond) {
    gMinesweeperLastSecond = second; minesweeperChanged();
  }
}
bool handleMinesweeperKey(char key, const Keyboard_Class::KeysState& keys) {
  beginMinesweeper();
  if (keys.ctrl || keys.alt || keys.opt) return true;
  const char lower = static_cast<char>(tolower(static_cast<unsigned char>(key)));
  if (lower == 'n') newMinesweeperGame();
  else if (lower == 'w' || key == ';') gMinesweeper.moveCursor(0, -1);
  else if (lower == 's' || key == '.') gMinesweeper.moveCursor(0, 1);
  else if (lower == 'a' || key == ',') gMinesweeper.moveCursor(-1, 0);
  else if (lower == 'd' || key == '/') gMinesweeper.moveCursor(1, 0);
  else if (lower == 'f' || keys.del || key == '\b') gMinesweeper.toggleFlag(gMinesweeper.cursor);
  else if (keys.enter || key == '\r' || key == '\n' || key == ' ') gMinesweeper.reveal(gMinesweeper.cursor, millis());
  minesweeperChanged();
  return true;
}
void renderMinesweeperUi() {
  beginMinesweeper();
  auto& d = gCanvas;
  const uint16_t bg = rgb565_local(8, 13, 22), muted = rgb565_local(157, 174, 195);
  const uint16_t closed = rgb565_local(170, 178, 189), opened = rgb565_local(209, 214, 220);
  const uint16_t edge = rgb565_local(100, 109, 121), ink = rgb565_local(10, 17, 27);
  const uint16_t red = rgb565_local(228, 39, 55), amber = rgb565_local(255, 185, 45);
  const uint16_t accent = rgb565_local(74, 238, 192);
  const uint16_t numbers[9] = {ink, rgb565_local(23, 64, 216), rgb565_local(12, 115, 45),
      rgb565_local(202, 24, 28), rgb565_local(44, 24, 127), rgb565_local(129, 38, 25),
      rgb565_local(0, 105, 123), ink, rgb565_local(90, 90, 90)};
  d.fillScreen(bg); d.setFont(&fonts::Font0);
  for (int square = 0; square < minesweeper::kCells; ++square) {
    const auto& cell = gMinesweeper.cells[square];
    const int x = 8 + (square % 9) * 12, y = 12 + (square / 9) * 12;
    const bool lost = gMinesweeper.phase == minesweeper::Phase::Lost;
    const bool showMine = lost && cell.mine;
    const uint16_t tile = square == gMinesweeper.detonated ? red : cell.opened ? opened : closed;
    d.fillRect(x, y, 12, 12, tile);
    if (cell.opened) d.drawRect(x, y, 12, 12, edge);
    else {
      d.drawLine(x, y, x + 11, y, TFT_WHITE); d.drawLine(x, y, x, y + 11, TFT_WHITE);
      d.drawLine(x + 11, y, x + 11, y + 11, edge); d.drawLine(x, y + 11, x + 11, y + 11, edge);
    }
    if (showMine) {
      d.fillCircle(x + 6, y + 6, 2, ink);
      d.drawLine(x + 2, y + 6, x + 9, y + 6, ink);
      d.drawLine(x + 6, y + 2, x + 6, y + 9, ink);
      d.drawPixel(x + 5, y + 5, TFT_WHITE);
    } else if (cell.flagged) {
      d.drawLine(x + 4, y + 3, x + 4, y + 9, ink);
      d.drawLine(x + 2, y + 9, x + 8, y + 9, ink);
      d.fillTriangle(x + 5, y + 2, x + 9, y + 4, x + 5, y + 6, red);
      if (lost && !cell.mine) {
        d.drawLine(x + 2, y + 2, x + 9, y + 9, red);
        d.drawLine(x + 9, y + 2, x + 2, y + 9, red);
      }
    } else if (cell.opened && cell.adjacent) {
      d.setTextColor(numbers[cell.adjacent], tile); d.setCursor(x + 3, y + 2); d.print(String(cell.adjacent));
    }
    if (square == gMinesweeper.cursor) {
      d.drawRect(x, y, 12, 12, amber); d.drawRect(x + 1, y + 1, 10, 10, amber);
    }
  }
  d.setFont(&fonts::Font2); d.setTextColor(accent, bg); d.setCursor(132, 8); d.print("MINES");
  d.setFont(&fonts::Font0); d.setTextColor(muted, bg); d.setCursor(132, 29); d.print("9x9 / 10 mines");
  const char* state = "FIRST PICK SAFE";
  if (gMinesweeper.phase == minesweeper::Phase::Playing) state = "CLEAR THE BOARD";
  else if (gMinesweeper.phase == minesweeper::Phase::Won) state = "YOU WIN!";
  else if (gMinesweeper.phase == minesweeper::Phase::Lost) state = "BOOM! N: NEW";
  d.setTextColor(TFT_WHITE, bg); d.setCursor(132, 43); d.print(state);
  d.setTextColor(muted, bg); d.setCursor(132, 55);
  d.print("Left " + String(minesweeper::kMines - int(gMinesweeper.flags)) + "  " + String(gMinesweeper.seconds(millis())) + "s");
  d.setCursor(132, 67); d.print("Clear " + String(gMinesweeper.opened) + "/71");
  d.setTextColor(amber, bg); d.setCursor(132, 79); d.print("Enter: reveal");
  d.setTextColor(muted, bg); d.setCursor(132, 91); d.print("WASD / arrows");
  d.setCursor(132, 101); d.print("F / Del: flag");
  d.setCursor(132, 111); d.print("N: new game");
  d.setCursor(132, 121); d.print("Esc exit Tab menu");
  renderLauncherOverlay(); renderDebugOverlay();
}
} // namespace
