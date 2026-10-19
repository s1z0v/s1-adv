#include <esp_wifi.h>
#include <esp_log.h>
#include "wifi_memory_budget.h"

extern "C" esp_err_t __real_esp_wifi_init(const wifi_init_config_t* config);
extern "C" esp_err_t __wrap_esp_wifi_init(const wifi_init_config_t* config) {
  if (!config) return __real_esp_wifi_init(config);
  const auto limited = wifi_memory_budget::bounded(*config);
  const esp_err_t result = __real_esp_wifi_init(&limited);
  ESP_LOGI("wifi-budget", "rx=%d tx=%d static_rx=%d ba=%d result=%d",
           limited.dynamic_rx_buf_num, limited.dynamic_tx_buf_num,
           limited.static_rx_buf_num, limited.rx_ba_win, static_cast<int>(result));
  return result;
}
