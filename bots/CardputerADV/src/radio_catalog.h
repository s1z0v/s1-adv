#pragma once
#include <cstddef>
#include <cstdint>

// Curated public MP3 streams, checked 2026-10-22. No account or bridge token.
// EN/INT means an international station (often instrumental), not a promise
// that every song is English. RU identifies a Russian-language station.
namespace radio_catalog {
enum class Language : uint8_t { All, International, Russian };
constexpr const char* kGenres[] = {"Jazz", "Funk / Soul", "Rock", "Electro / House", "Chill", "Lounge", "Russian mix"};
constexpr size_t kGenresCount = sizeof(kGenres) / sizeof(kGenres[0]);
struct Station { const char* name; const char* url; uint8_t genre; Language language; };
constexpr Station kStations[] = {
 {"Sonic Universe", "http://ice2.somafm.com/sonicuniverse-128-mp3", 0, Language::International},
 {"Instrumental Jazz", "http://jfm1.hostingradio.ru:14536/ijstream.mp3", 0, Language::Russian},
 {"Funky Radio", "http://funkyradio.streamingmedia.it/play.mp3", 1, Language::International},
 {"Seven Inch Soul", "http://ice2.somafm.com/7soul-128-mp3", 1, Language::International},
 {"Radio Paradise", "http://stream.radioparadise.com/mp3-128", 2, Language::International},
 {"Indie Pop Rocks", "http://ice2.somafm.com/indiepop-128-mp3", 2, Language::International},
 {"Nashe Radio", "http://nashe1.hostingradio.ru/nashe-128.mp3", 2, Language::Russian},
 {"Rock FM", "http://nashe1.hostingradio.ru/rock-128.mp3", 2, Language::Russian},
 {"Beat Blender", "http://ice2.somafm.com/beatblender-128-mp3", 3, Language::International},
 {"DEF CON", "http://ice2.somafm.com/defcon-128-mp3", 3, Language::International},
 {"cliqhop IDM", "http://ice2.somafm.com/cliqhop-128-mp3", 3, Language::International},
 {"Groove Salad", "http://ice2.somafm.com/groovesalad-128-mp3", 4, Language::International},
 {"Lush", "http://ice2.somafm.com/lush-128-mp3", 4, Language::International},
 {"101.ru Chill Out", "http://pub0201.101.ru/stream/trust/mp3/128/24", 4, Language::Russian},
 {"Secret Agent", "http://ice2.somafm.com/secretagent-128-mp3", 5, Language::International},
 {"Illinois Lounge", "http://ice2.somafm.com/illstreet-128-mp3", 5, Language::International},
 {"Russkie Pesni", "http://listen.rusongs.ru/ru-mp3-128", 6, Language::Russian},
 {"Nashe Radio", "http://nashe1.hostingradio.ru/nashe-128.mp3", 6, Language::Russian},
};
constexpr size_t kStationCount = sizeof(kStations) / sizeof(kStations[0]);
inline const char* languageName(Language language) {
 return language == Language::All ? "ALL" : language == Language::Russian ? "RU" : "EN/INT";
}
struct Selection {
 uint8_t genre = 0;
 uint8_t index = 0;
 Language language = Language::All;
 bool matches(const Station& station, uint8_t group) const {
  return station.genre == group && (language == Language::All || language == station.language);
 }
 uint8_t count(uint8_t group) const {
  uint8_t n = 0; for (const auto& s : kStations) if (matches(s, group)) ++n; return n;
 }
 const Station* station() const {
  uint8_t n = 0; for (const auto& s : kStations) if (matches(s, genre) && n++ == index) return &s;
  return nullptr;
 }
 void moveGenre(int delta) {
  for (size_t i = 0; i < kGenresCount; ++i) {
   genre = static_cast<uint8_t>((int(genre) + int(kGenresCount) + (delta < 0 ? -1 : 1)) % int(kGenresCount));
   if (count(genre)) { index = 0; return; }
  }
  index = 0;
 }
 void moveStation(int delta) {
  const int n = count(genre); index = n ? static_cast<uint8_t>((int(index) + n + (delta < 0 ? -1 : 1)) % n) : 0;
 }
 void nextLanguage() {
  language = static_cast<Language>((static_cast<unsigned>(language) + 1) % 3);
  index = 0; if (!count(genre)) moveGenre(1);
 }
};
} // namespace radio_catalog
