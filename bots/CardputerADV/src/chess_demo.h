#pragma once
// Small allocation-free chess rules for the offline demo. White is the human.
// Promotions are always queens; repetition/50-move draws are intentionally omitted.
#include <stdint.h>
#include <initializer_list>

namespace chess_demo {
enum Piece : int8_t { Empty = 0, Pawn = 1, Knight, Bishop, Rook, Queen, King };
inline int absPiece(int p) { return p < 0 ? -p : p; }
inline bool onBoard(int f, int r) { return f >= 0 && f < 8 && r >= 0 && r < 8; }
inline int sideOf(int p) { return (p > 0) - (p < 0); }
struct Move { uint8_t from = 0, to = 0; };
struct MoveList {
  Move moves[256] = {};
  uint16_t count = 0;
  void add(int from, int to) { if (count < 256) moves[count++] = {uint8_t(from), uint8_t(to)}; }
  bool contains(int from, int to) const {
    for (uint16_t i = 0; i < count; ++i)
      if (moves[i].from == from && moves[i].to == to) return true;
    return false;
  }
};
struct Position {
  int8_t board[64] = {};
  int8_t turn = 1;
  uint8_t castle = 15; // white K/Q, black K/Q
  int8_t ep = -1;
  void reset() {
    const int8_t row[8] = {Rook, Knight, Bishop, Queen, King, Bishop, Knight, Rook};
    for (int s = 0; s < 64; ++s) board[s] = 0;
    for (int f = 0; f < 8; ++f) {
      board[f] = row[f]; board[8 + f] = Pawn;
      board[48 + f] = -Pawn; board[56 + f] = -row[f];
    }
    turn = 1; castle = 15; ep = -1;
  }
  bool attacked(int square, int by) const {
    const int f = square % 8, r = square / 8;
    for (int df : {-1, 1}) {
      const int sr = r - by, sf = f + df;
      if (onBoard(sf, sr) && board[sr * 8 + sf] == by * Pawn) return true;
    }
    static const int8_t knight[8][2] = {{1,2},{2,1},{2,-1},{1,-2},{-1,-2},{-2,-1},{-2,1},{-1,2}};
    for (const auto& d : knight) {
      const int sf = f + d[0], sr = r + d[1];
      if (onBoard(sf, sr) && board[sr * 8 + sf] == by * Knight) return true;
    }
    for (int df = -1; df <= 1; ++df) for (int dr = -1; dr <= 1; ++dr) {
      if (df == 0 && dr == 0) continue;
      for (int n = 1; n < 8; ++n) {
        const int sf = f + df * n, sr = r + dr * n;
        if (!onBoard(sf, sr)) break;
        const int p = board[sr * 8 + sf];
        if (!p) continue;
        if (sideOf(p) == by) {
          const int type = absPiece(p);
          if ((n == 1 && type == King) || type == Queen ||
              (df != 0 && dr != 0 ? type == Bishop : type == Rook)) return true;
        }
        break;
      }
    }
    return false;
  }
  bool inCheck(int side) const {
    for (int s = 0; s < 64; ++s) if (board[s] == side * King) return attacked(s, -side);
    return true; // reject malformed positions with a missing king
  }
  void clearRookRight(int square) {
    if (square == 0) castle &= ~2;
    if (square == 7) castle &= ~1;
    if (square == 56) castle &= ~8;
    if (square == 63) castle &= ~4;
  }
  // Internal only: caller must have validated against legalMoves().
  void apply(Move move) {
    const int from = move.from, to = move.to, p = board[from], type = absPiece(p);
    if (type == Pawn && to == ep && !board[to] && from % 8 != to % 8)
      board[to - turn * 8] = 0;
    if (type == King) {
      castle &= turn == 1 ? ~3 : ~12;
      if (to - from == 2) { board[from + 1] = board[from + 3]; board[from + 3] = 0; }
      if (from - to == 2) { board[from - 1] = board[from - 4]; board[from - 4] = 0; }
    }
    clearRookRight(from); clearRookRight(to);
    board[from] = 0; board[to] = p;
    if (type == Pawn && (to / 8 == 0 || to / 8 == 7)) board[to] = turn * Queen;
    ep = type == Pawn && absPiece(to - from) == 16 ? (from + to) / 2 : -1;
    turn = -turn;
  }
  void candidate(MoveList& out, int from, int to) const {
    if (sideOf(board[to]) == turn || absPiece(board[to]) == King) return;
    Position next = *this;
    next.apply({uint8_t(from), uint8_t(to)});
    if (!next.inCheck(turn)) out.add(from, to);
  }
  MoveList legalMoves() const {
    MoveList out;
    for (int from = 0; from < 64; ++from) {
      const int p = board[from], type = absPiece(p), f = from % 8, r = from / 8;
      if (sideOf(p) != turn) continue;
      if (type == Pawn) {
        const int nr = r + turn;
        if (!onBoard(f, nr)) continue;
        if (!board[nr * 8 + f]) {
          candidate(out, from, nr * 8 + f);
          const int nr2 = r + 2 * turn;
          if (r == (turn == 1 ? 1 : 6) && !board[nr2 * 8 + f]) candidate(out, from, nr2 * 8 + f);
        }
        for (int df : {-1, 1}) if (onBoard(f + df, nr)) {
          const int to = nr * 8 + f + df;
          if (sideOf(board[to]) == -turn ||
              (to == ep && !board[to] && board[to - turn * 8] == -turn * Pawn)) candidate(out, from, to);
        }
      } else if (type == Knight) {
        static const int8_t steps[8][2] = {{1,2},{2,1},{2,-1},{1,-2},{-1,-2},{-2,-1},{-2,1},{-1,2}};
        for (const auto& d : steps) if (onBoard(f + d[0], r + d[1])) candidate(out, from, (r + d[1]) * 8 + f + d[0]);
      } else {
        for (int df = -1; df <= 1; ++df) for (int dr = -1; dr <= 1; ++dr) {
          if ((!df && !dr) || (type == Bishop && (!df || !dr)) || (type == Rook && df && dr)) continue;
          for (int n = 1; n <= (type == King ? 1 : 7); ++n) {
            const int nf = f + df * n, nr = r + dr * n;
            if (!onBoard(nf, nr)) break;
            const int to = nr * 8 + nf;
            candidate(out, from, to);
            if (board[to]) break;
          }
        }
        if (type == King && from == (turn == 1 ? 4 : 60) && !inCheck(turn)) {
          const int rights = turn == 1 ? castle : castle >> 2;
          if ((rights & 1) && board[from + 3] == turn * Rook && !board[from + 1] && !board[from + 2] &&
              !attacked(from + 1, -turn) && !attacked(from + 2, -turn)) candidate(out, from, from + 2);
          if ((rights & 2) && board[from - 4] == turn * Rook && !board[from - 1] && !board[from - 2] && !board[from - 3] &&
              !attacked(from - 1, -turn) && !attacked(from - 2, -turn)) candidate(out, from, from - 2);
        }
      }
    }
    return out;
  }
};
enum class Result : uint8_t { Playing, WhiteWins, BlackWins, Stalemate };
inline Result result(const Position& p, const MoveList& legal) {
  if (legal.count) return Result::Playing;
  if (!p.inCheck(p.turn)) return Result::Stalemate;
  return p.turn == 1 ? Result::BlackWins : Result::WhiteWins;
}
inline int value(int type) {
  const int values[7] = {0, 100, 320, 330, 500, 900, 0};
  return values[type];
}
// Easy one-ply opponent, not a competitive engine. Bounded work, no recursion.
inline int moveScore(const Position& p, Move m) {
  Position next = p; next.apply(m);
  int score = 0;
  for (int s = 0; s < 64; ++s) {
    const int piece = next.board[s], type = absPiece(piece), side = sideOf(piece);
    if (!piece) continue;
    const int f = s % 8, r = side == 1 ? s / 8 : 7 - s / 8;
    int bonus = type == Pawn ? r * 6 : 0;
    if (type == Knight || type == Bishop) bonus += 14 - absPiece(2 * f - 7) - absPiece(2 * r - 7);
    score += (side == p.turn ? 1 : -1) * (value(type) + bonus);
  }
  const int movedType = absPiece(next.board[m.to]);
  if (next.attacked(m.to, -p.turn)) score -= value(movedType) * 3 / 4;
  if (absPiece(p.board[m.from]) == King && absPiece(int(m.to) - int(m.from)) == 2) score += 35;
  if (next.inCheck(-p.turn)) score += 20;
  return score;
}
struct Game {
  Position position;
  MoveList legal;
  Result outcome = Result::Playing;
  Move last;
  bool started = false, hasLast = false;
  int8_t cursor = 12, selected = -1;
  uint16_t plies = 0;
  void reset() {
    position.reset(); legal = position.legalMoves(); outcome = Result::Playing;
    started = true; hasLast = false; cursor = 12; selected = -1; plies = 0;
  }
  bool play(int from, int to) {
    if (outcome != Result::Playing || !legal.contains(from, to)) return false;
    last = {uint8_t(from), uint8_t(to)}; hasLast = true;
    position.apply(last); ++plies; selected = -1;
    legal = position.legalMoves(); outcome = result(position, legal);
    return true;
  }
  void moveCursor(int df, int dr) {
    const int f = cursor % 8 + df, r = cursor / 8 + dr;
    if (onBoard(f, r)) cursor = r * 8 + f;
  }
};
} // namespace chess_demo
