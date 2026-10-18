#pragma once

namespace nes_view {
constexpr int height = 135;
constexpr int width(bool wide) { return wide ? 240 : 180; }
constexpr int left(bool wide) { return (240 - width(wide)) / 2; }
constexpr int sourceX(int x, bool wide) { return ((2 * x + 1) * 256) / (2 * width(wide)); }
constexpr int sourceRow(int y) { return (((2 * y + 1) * 120) / (2 * height)) * 2; }
}
