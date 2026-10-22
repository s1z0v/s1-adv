#pragma once
// Offline 8x8 English/American-style checkers: forward men, short kings,
// mandatory captures and same-piece multiple jumps. Crowning ends the turn.
// Red (human) moves first. Repetition/no-progress draws are not adjudicated.
#include <stdint.h>

namespace checkers_demo {
inline int sideOf(int p) { return (p > 0) - (p < 0); }
inline int magnitude(int p) { return p < 0 ? -p : p; }
inline bool inside(int f, int r) { return f >= 0 && f < 8 && r >= 0 && r < 8; }
inline bool dark(int f, int r) { return inside(f, r) && ((f + r) & 1) == 0; }
struct Move { uint8_t from = 0, to = 0; };
struct MoveList {
  Move moves[128] = {};
  uint8_t count = 0;
  void add(int from, int to) { if (count < 128) moves[count++] = {uint8_t(from), uint8_t(to)}; }
  bool contains(int from, int to) const {
    for (int i = 0; i < count; ++i) if (moves[i].from == from && moves[i].to == to) return true;
    return false;
  }
  bool fromSquare(int square) const {
    for (int i = 0; i < count; ++i) if (moves[i].from == square) return true;
    return false;
  }
};
enum class Result : uint8_t { Playing, RedWins, BlackWins };
struct Game {
  int8_t board[64] = {};
  int8_t turn = 1, forced = -1, cursor = 18, selected = -1;
  MoveList legal;
  Move last;
  Result outcome = Result::Playing;
  bool started = false, hasLast = false;
  uint16_t turns = 0;
  // 1/-1 are men, 2/-2 are kings. All pieces stay on dark squares.
  void addMoves(MoveList& out, int square, bool captures) const {
    const int piece = board[square], f = square % 8, r = square / 8;
    if (sideOf(piece) != turn || !dark(f, r)) return;
    const int distance = captures ? 2 : 1;
    for (int dr = -1; dr <= 1; dr += 2) {
      if (magnitude(piece) == 1 && dr != turn) continue;
      for (int df = -1; df <= 1; df += 2) {
        const int nf = f + distance * df, nr = r + distance * dr;
        if (!dark(nf, nr) || board[nr * 8 + nf]) continue;
        if (!captures || sideOf(board[(r + dr) * 8 + f + df]) == -turn)
          out.add(square, nr * 8 + nf);
      }
    }
  }
  MoveList moves() const {
    MoveList out;
    if (forced >= 0) { addMoves(out, forced, true); return out; }
    for (int s = 0; s < 64; ++s) addMoves(out, s, true);
    if (!out.count) for (int s = 0; s < 64; ++s) addMoves(out, s, false);
    return out;
  }
  bool captureRequired() const {
    return legal.count && magnitude(int(legal.moves[0].to) / 8 - int(legal.moves[0].from) / 8) == 2;
  }
  void refresh() {
    legal = moves();
    outcome = legal.count ? Result::Playing : (turn == 1 ? Result::BlackWins : Result::RedWins);
  }
  void reset() {
    for (int s = 0; s < 64; ++s) {
      const int r = s / 8, f = s % 8;
      board[s] = dark(f, r) ? (r < 3 ? 1 : r > 4 ? -1 : 0) : 0;
    }
    turn = 1; forced = selected = -1; cursor = 18; turns = 0;
    started = true; hasLast = false; refresh();
  }
  bool play(int from, int to) {
    if (outcome != Result::Playing || !legal.contains(from, to)) return false;
    const int piece = board[from];
    const bool capture = magnitude(to / 8 - from / 8) == 2;
    board[from] = 0; board[to] = piece;
    if (capture) board[((from / 8 + to / 8) / 2) * 8 + (from % 8 + to % 8) / 2] = 0;
    const bool crowned = magnitude(piece) == 1 && to / 8 == (turn == 1 ? 7 : 0);
    if (crowned) board[to] = 2 * turn;
    last = {uint8_t(from), uint8_t(to)}; hasLast = true;
    forced = selected = -1;
    if (capture && !crowned) {
      MoveList more; addMoves(more, to, true);
      if (more.count) {
        forced = selected = to; legal = more;
        return true; // same piece must finish its capture chain
      }
    }
    turn = -turn; ++turns; refresh();
    return true;
  }
  void moveCursor(int df, int dr) {
    const int f = cursor % 8 + df, r = cursor / 8 + dr;
    if (inside(f, r)) cursor = r * 8 + f;
  }
};
// Easy non-recursive opponent; evaluate only legal single steps/jumps.
inline int moveScore(const Game& game, Move move) {
  Game next = game;
  if (!next.play(move.from, move.to)) return -32767;
  if (next.outcome != Result::Playing) return 20000;
  int score = 0;
  for (int s = 0; s < 64; ++s) if (next.board[s]) {
    const int side = sideOf(next.board[s]), type = magnitude(next.board[s]);
    const int rank = side == 1 ? s / 8 : 7 - s / 8;
    const int f = s % 8;
    const int bonus = (type == 1 ? rank * 3 : 12 - magnitude(2 * f - 7));
    score += (side == game.turn ? 1 : -1) * ((type == 2 ? 175 : 100) + bonus);
  }
  if (next.turn == game.turn) score += 45; // continuation available
  else if (next.captureRequired()) {
    for (int i = 0; i < next.legal.count; ++i) {
      const auto reply = next.legal.moves[i];
      const int captured = ((reply.from / 8 + reply.to / 8) / 2) * 8 + (reply.from % 8 + reply.to % 8) / 2;
      if (captured == move.to) { score -= magnitude(next.board[captured]) == 2 ? 150 : 90; break; }
    }
  }
  return score;
}
} // namespace checkers_demo
