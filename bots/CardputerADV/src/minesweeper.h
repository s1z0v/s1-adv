#pragma once
// Fixed-size beginner Minesweeper. No heap, recursion, storage or network.
#include <stdint.h>

namespace minesweeper {
constexpr int kSide = 9, kCells = kSide * kSide, kMines = 10;
enum class Phase : uint8_t { Ready, Playing, Won, Lost };
struct Cell {
  uint8_t adjacent = 0;
  bool mine = false, opened = false, flagged = false;
};
inline bool valid(int square) { return square >= 0 && square < kCells; }
inline bool inside(int x, int y) { return x >= 0 && x < kSide && y >= 0 && y < kSide; }
inline int magnitude(int n) { return n < 0 ? -n : n; }
struct Game {
  Cell cells[kCells];
  Phase phase = Phase::Ready;
  int8_t cursor = 40, detonated = -1;
  uint8_t flags = 0, opened = 0;
  bool initialized = false;
  uint32_t randomState = 1, startedMs = 0, finishedMs = 0;
  void reset(uint32_t seed) {
    for (auto& cell : cells) cell = Cell{};
    phase = Phase::Ready; cursor = 40; detonated = -1; flags = opened = 0;
    initialized = true; randomState = seed ? seed : 0x9e3779b9U;
    startedMs = finishedMs = 0;
  }
  uint32_t random() {
    randomState ^= randomState << 13;
    randomState ^= randomState >> 17;
    randomState ^= randomState << 5;
    return randomState;
  }
  void countNeighbors() {
    for (int square = 0; square < kCells; ++square) {
      uint8_t count = 0;
      const int x = square % kSide, y = square / kSide;
      for (int dy = -1; dy <= 1; ++dy) for (int dx = -1; dx <= 1; ++dx)
        if ((dx || dy) && inside(x + dx, y + dy) && cells[(y + dy) * kSide + x + dx].mine) ++count;
      cells[square].adjacent = count;
    }
  }
  void placeMines(int first) {
    uint8_t candidates[kCells];
    int count = 0;
    for (int square = 0; square < kCells; ++square)
      if (magnitude(square % kSide - first % kSide) > 1 || magnitude(square / kSide - first / kSide) > 1)
        candidates[count++] = square;
    // Partial shuffle guarantees exactly ten unique mines, with bounded work.
    for (int i = 0; i < kMines; ++i) {
      const int picked = i + random() % (count - i);
      const uint8_t square = candidates[picked];
      candidates[picked] = candidates[i]; candidates[i] = square;
      cells[square].mine = true;
    }
    countNeighbors();
  }
  uint16_t seconds(uint32_t now) const {
    if (phase == Phase::Ready) return 0;
    const uint32_t elapsed = (phase == Phase::Playing ? now : finishedMs) - startedMs;
    return elapsed / 1000U > 999U ? 999 : elapsed / 1000U;
  }
  bool toggleFlag(int square) {
    if (!valid(square) || cells[square].opened || phase == Phase::Won || phase == Phase::Lost) return false;
    cells[square].flagged = !cells[square].flagged;
    if (cells[square].flagged) ++flags; else --flags;
    return true;
  }
  bool chord(int square, uint32_t now) {
    if (!valid(square) || phase != Phase::Playing || !cells[square].opened || !cells[square].adjacent) return false;
    const int x = square % kSide, y = square / kSide;
    int nearbyFlags = 0;
    for (int dy = -1; dy <= 1; ++dy) for (int dx = -1; dx <= 1; ++dx)
      if ((dx || dy) && inside(x + dx, y + dy) && cells[(y + dy) * kSide + x + dx].flagged) ++nearbyFlags;
    if (nearbyFlags != cells[square].adjacent) return false;
    bool changed = false;
    for (int dy = -1; dy <= 1; ++dy) for (int dx = -1; dx <= 1; ++dx) {
      if (phase != Phase::Playing) return changed;
      if ((!dx && !dy) || !inside(x + dx, y + dy)) continue;
      const int neighbor = (y + dy) * kSide + x + dx;
      if (!cells[neighbor].opened && !cells[neighbor].flagged) changed |= openCell(neighbor, now);
    }
    return changed;
  }
  bool openCell(int square, uint32_t now) {
    if (!valid(square) || phase == Phase::Won || phase == Phase::Lost || cells[square].flagged) return false;
    if (cells[square].opened) return false;
    if (phase == Phase::Ready) { placeMines(square); phase = Phase::Playing; startedMs = now; }
    if (cells[square].mine) {
      cells[square].opened = true; detonated = square;
      phase = Phase::Lost; finishedMs = now; return true;
    }
    // Each cell is marked before enqueuing, so the queue never exceeds 81.
    uint8_t queue[kCells];
    int head = 0, tail = 0;
    cells[square].opened = true; ++opened;
    if (!cells[square].adjacent) queue[tail++] = square;
    while (head < tail) {
      const int current = queue[head++], x = current % kSide, y = current / kSide;
      for (int dy = -1; dy <= 1; ++dy) for (int dx = -1; dx <= 1; ++dx) {
        if ((!dx && !dy) || !inside(x + dx, y + dy)) continue;
        const int neighbor = (y + dy) * kSide + x + dx;
        Cell& cell = cells[neighbor];
        if (cell.mine || cell.opened || cell.flagged) continue;
        cell.opened = true; ++opened;
        if (!cell.adjacent) queue[tail++] = neighbor;
      }
    }
    if (opened == kCells - kMines) {
      phase = Phase::Won; finishedMs = now; flags = kMines;
      for (auto& cell : cells) if (cell.mine) cell.flagged = true;
    }
    return true;
  }
  bool reveal(int square, uint32_t now) {
    return valid(square) && cells[square].opened ? chord(square, now) : openCell(square, now);
  }
  void moveCursor(int dx, int dy) {
    const int x = cursor % kSide + dx, y = cursor / kSide + dy;
    if (inside(x, y)) cursor = y * kSide + x;
  }
};
} // namespace minesweeper
