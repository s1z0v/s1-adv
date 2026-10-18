#pragma once
#include <stdint.h>
#include <stddef.h>
#include <math.h>

namespace release_delivery {
inline bool versionCore(const char* text, uint32_t (&out)[3]) {
  if (!text) return false;
  for (unsigned i=0;i<3;++i) {
    if (*text<'0' || *text>'9') return false;
    out[i]=0;
    while (*text>='0' && *text<='9') {
      const unsigned digit=static_cast<unsigned>(*text++-'0');
      if (out[i]>(UINT32_MAX-digit)/10) return false;
      out[i]=out[i]*10+digit;
    }
    if (i<2) { if (*text++!='.') return false; }
  }
  return *text=='\0' || ((*text=='-' || *text=='+') && text[1]!='\0');
}
inline bool isNewerVersion(const char* candidate, const char* current) {
  uint32_t next[3],now[3];
  if (!versionCore(candidate,next) || !versionCore(current,now)) return false;
  for (unsigned i=0;i<3;++i) if (next[i]!=now[i]) return next[i]>now[i];
  return false;
}
inline bool otaPowerAllowed(int level, bool external, unsigned minimum) {
  return external || (level >= 0 && static_cast<unsigned>(level) >= minimum);
}
constexpr size_t kChimeSamples = 1920;
constexpr uint32_t kChimeRate = 8000;
inline void makeUpdateChime(int16_t* samples) {
  // Two low, damped wooden taps. Peak stays below 6% of PCM full scale.
  for (size_t i=0;i<kChimeSamples;++i) {
    const float t=static_cast<float>(i)/kChimeRate;
    float local=t, gain=1.0f;
    if(t>=0.118f){local=t-0.118f;gain=0.72f;}
    if(local<0.0f || local>=0.076f){samples[i]=0;continue;}
    const float attack=1.0f-expf(-local/0.0018f);
    const float tail=fminf(1.0f,(0.076f-local)/0.008f);
    const float envelope=attack*expf(-local/0.018f)*tail;
    const float body=sinf(6.2831853f*(310.0f*local+1.8f*(1.0f-expf(-65.0f*local))));
    const float wood=body+0.24f*sinf(6.2831853f*740.0f*local)+
                          0.08f*sinf(6.2831853f*1200.0f*local);
    samples[i]=static_cast<int16_t>(1800.0f*gain*envelope*wood);
  }
}
}
