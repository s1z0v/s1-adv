#include "pocket_synth_audio.h"
#include <M5Cardputer.h>
#include <atomic>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

namespace synth_audio {
namespace {
portMUX_TYPE mux=portMUX_INITIALIZER_UNLOCKED;
Control desired;
std::atomic<bool> running{false},cancel{false},fault{false},draining{false};
std::atomic<uint8_t> voices{0};
std::atomic<uint32_t> blocks{0},starvations{0};
// Static lifetime includes asynchronous stop and the final queued request.
// Three slots, single producer, only refill below queue depth two.
int16_t pcm[3][kBlockSamples]={};
Control snapshot(){portENTER_CRITICAL(&mux);Control c=desired;portEXIT_CRITICAL(&mux);return c;}
void producer(void*){
  pocket_synth::Synth synth;uint8_t slot=0;bool hadData=false;
  while(!cancel.load(std::memory_order_acquire)){
    Control c=snapshot();
    if(synth.octave!=c.octave||synth.patch!=c.patch){synth.panic();synth.octave=c.octave;synth.patch=c.patch;}
    synth.gain=c.gain;synth.setSustain(c.sustain);synth.sync(c.mask);
    voices.store(synth.activeCount(),std::memory_order_relaxed);
    if(!synth.active()){
      vTaskDelay(2);continue; // stay ready for the next key without racing task teardown
    }
    if(M5Cardputer.Speaker.isPlaying(kChannel)==0&&hadData)++starvations;
    for(int work=0;work<2&&synth.active()&&!cancel.load(std::memory_order_acquire)&&
        M5Cardputer.Speaker.isPlaying(kChannel)<2;++work){
      synth.render(pcm[slot],kBlockSamples);
      if(cancel.load(std::memory_order_acquire))break; // no queue after cancellation acknowledgement
      if(!M5Cardputer.Speaker.playRaw(pcm[slot],kBlockSamples,pocket_synth::kRate,false,1,kChannel,false)){
        fault.store(true,std::memory_order_release);cancel.store(true,std::memory_order_release);break;
      }
      ++blocks;hadData=true;slot=(slot+1)%3;
    }
    // Audio producer preempts LCD/SD work but never spin-loops above the M5 task.
    vTaskDelay(1);
  }
  if(cancel.load(std::memory_order_acquire)){
    draining.store(true,std::memory_order_release);
    M5Cardputer.Speaker.stop(kChannel);
  }
  voices.store(0,std::memory_order_relaxed);
  running.store(false,std::memory_order_release); // no PCM/speaker access after this store
  vTaskDelete(nullptr);
}
bool valid(const Control& c){return c.octave>=2&&c.octave<=5&&c.gain<=100&&unsigned(c.patch)<4&&(c.mask>>pocket_synth::kKeys)==0;}
}
void update(const Control& control){if(!valid(control))return;portENTER_CRITICAL(&mux);desired=control;portEXIT_CRITICAL(&mux);}
Status status(){
  if(draining.load(std::memory_order_acquire)&&!running.load(std::memory_order_acquire)&&!M5Cardputer.Speaker.isPlaying(kChannel))draining.store(false,std::memory_order_release);
  return {running.load(std::memory_order_acquire),draining.load(std::memory_order_acquire),fault.load(std::memory_order_acquire),voices.load(std::memory_order_relaxed),blocks.load(std::memory_order_relaxed),starvations.load(std::memory_order_relaxed)};
}
bool busy(){auto s=status();return s.running||s.draining;}
bool start(const Control& control){
  if(!valid(control)||!control.mask||busy()||M5Cardputer.Speaker.isPlaying())return false;
  const auto cfg=M5Cardputer.Speaker.config();
  // M5Unified owns ADV ES8311 setup, MCLK-from-BCLK and I2S1 pin routing.
  // Refuse an unexpected backend instead of rewriting codec/GPIO/voice setup.
  if(cfg.sample_rate!=pocket_synth::kRate||cfg.pin_bck!=41||cfg.pin_ws!=43||cfg.pin_data_out!=42||
     cfg.i2s_port!=I2S_NUM_1||cfg.stereo||cfg.buzzer||cfg.use_dac){fault.store(true,std::memory_order_release);return false;}
  update(control);cancel.store(false,std::memory_order_release);fault.store(false,std::memory_order_release);
  blocks.store(0,std::memory_order_relaxed);starvations.store(0,std::memory_order_relaxed);running.store(true,std::memory_order_release);
  if(xTaskCreate(producer,"synth-pcm",kStackBytes,nullptr,kPriority,nullptr)!=pdPASS){
    running.store(false,std::memory_order_release);fault.store(true,std::memory_order_release);return false;
  }
  return true;
}
bool stop(uint32_t timeoutMs){
  cancel.store(true,std::memory_order_release);
  const uint32_t start=millis();
  while(busy()){
    if(uint32_t(millis()-start)>=timeoutMs)return false;
    vTaskDelay(1);
  }
  return true;
}
} // namespace synth_audio
