#pragma once
#include "mesh_leaf_state.h"
#include <RadioLib.h>
#include <libmeshtastic_leaf.h>
#include <atomic>

namespace s1_mesh {
constexpr int kInitPending = -32768;
struct RadioSession {
  Module module;
  SX1262 radio;
  libmeshtastic_leaf::libmeshtastic_leaf mesh;
  State state;
  std::atomic<int> initResult{kInitPending};
  bool readyReported=false;
  uint32_t lowHeap=UINT32_MAX, lowLargest=UINT32_MAX;
  explicit RadioSession(SPIClass& spi):module(5,4,3,6,spi),radio(&module) {
    module.spiConfig.timeout=250; // A missing/busy chip cannot stall the UI task.
  }
  int initialize() {
    int e=radio.begin(923.875f,250.0f,11,5,RADIOLIB_SX126X_SYNC_WORD_PRIVATE,10,16,1.8f);
    if(e) return e;
    if((e=radio.setDio2AsRfSwitch(true)))return e;
    if((e=radio.setCurrentLimit(140.0f)))return e;
    if((e=radio.setCRC(2)))return e;
    libmeshtastic_leaf::MeshConfig cfg;
    cfg.radio.region=libmeshtastic_leaf::REGION_TH;
    cfg.radio.preset=libmeshtastic_leaf::PRESET_LONG_FAST;
    cfg.radio.txPower=10;
    cfg.hopLimit=3;
    mesh.setOwner("S1-ADV", "S1");
    return mesh.begin(cfg,&radio) ? 0 : RADIOLIB_ERR_UNKNOWN;
  }
};
} // namespace s1_mesh
