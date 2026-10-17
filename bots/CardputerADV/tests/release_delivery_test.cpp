#include "../src/release_delivery.h"
#include <cassert>
#include <cstdlib>
#include <cstdio>
#include <algorithm>
#include <initializer_list>
int main() {
  assert(release_delivery::isNewerVersion("0.2.149-dev","0.2.148-dev"));
  assert(!release_delivery::isNewerVersion("0.2.148-dev","0.2.149-dev"));
  assert(!release_delivery::isNewerVersion("0.2.149-dev","0.2.149-dev"));
  assert(!release_delivery::isNewerVersion("0.2.149-security.1","0.2.149-dev"));
  assert(release_delivery::isNewerVersion("0.3.0-dev","0.2.999-dev"));
  assert(release_delivery::isNewerVersion("1.0.0","0.99.999"));
  for(const char* bad:{"", "latest", "0.2", "0.2.150garbage", "0.2.150-", "4294967296.0.0"})
    assert(!release_delivery::isNewerVersion(bad,"0.2.149-dev"));
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
