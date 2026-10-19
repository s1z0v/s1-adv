#pragma once

namespace wifi_memory_budget {
constexpr int kPacketBuffers = 16;
// Bound runtime packet growth instead of replacing the SDK configuration or
// allocating the PSRAM-oriented static pool on this no-PSRAM ADV target.
template <typename Config> Config bounded(Config config) {
  if (config.tx_buf_type == 1 && config.dynamic_tx_buf_num > kPacketBuffers)
    config.dynamic_tx_buf_num = kPacketBuffers;
  const int rxLimit = config.static_rx_buf_num > kPacketBuffers
      ? config.static_rx_buf_num : kPacketBuffers;
  if (config.dynamic_rx_buf_num == 0 || config.dynamic_rx_buf_num > rxLimit)
    config.dynamic_rx_buf_num = rxLimit;
  if (config.ampdu_rx_enable && config.rx_ba_win > rxLimit)
    config.rx_ba_win = rxLimit;
  return config;
}
}  // namespace wifi_memory_budget
