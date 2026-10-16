#include "../src/release_delivery.h"
#include <cassert>
#include <cstdlib>
#include <cstdio>
#include <algorithm>
#include <initializer_list>
int main() {
  unsigned tests=0;
  for(int level=-1;level<=100;++level) for(unsigned min=5;min<=95;++min) for(bool ext:{false,true}) {
    assert(release_delivery::otaPowerAllowed(level,ext,min)==(ext || level>=static_cast<int>(min)));++tests;
  }
  int16_t pcm[release_delivery::kChimeSamples];
  release_delivery::makeUpdateChime(pcm);
  assert(pcm[0]==0 && std::abs(pcm[release_delivery::kChimeSamples-1])<=1);
  int peak=0; for(auto sample:pcm) {peak=std::max(peak,std::abs(static_cast<int>(sample)));assert(std::abs(static_cast<int>(sample))<5400);}
  assert(peak>1000);
  std::printf("PASS OTA power/chime: %u power boundaries, %zu samples, peak=%d\n",tests,release_delivery::kChimeSamples,peak);
}
