void loadFocusSettings() {
  gPrefs.begin(kPrefsFocusNs, true);
  gFocusSettings.focusSec = gPrefs.getUInt("focus", kFocusDefaultSec);
  gFocusSettings.shortBreakSec = gPrefs.getUInt("short", kFocusShortBreakDefaultSec);
  gFocusSettings.longBreakSec = gPrefs.getUInt("long", kFocusLongBreakDefaultSec);
  gFocusSettings.cyclesPerRound = static_cast<uint8_t>(gPrefs.getUChar("cycles", kFocusDefaultCycles));
  gFocusSettings.autoStart = gPrefs.getBool("auto", false);
  gFocusSettings.metronome = gPrefs.getBool("metro", false);
  gFocusSettings.guidedAudio = gPrefs.getBool("guided_audio", true);
  gFocusSettings.bpm = static_cast<uint16_t>(gPrefs.getUShort("bpm", 60));
  gFocusSettings.lampSync = gPrefs.getBool("lamp_link", DEFAULT_FOCUS_LAMP_ENABLED != 0);
  gFocusSettings.lampFocusPreset = static_cast<int8_t>(clampValue<int>(gPrefs.getChar("lamp_focus", 1), -1, 39));
  gFocusSettings.lampBreakPreset = static_cast<int8_t>(clampValue<int>(gPrefs.getChar("lamp_break", 5), -1, 39));
  gPrefs.end();

  gFocusSettings.focusSec = clampValue<uint32_t>(gFocusSettings.focusSec, kFocusMinDurationSec, kFocusMaxDurationSec);
  gFocusSettings.shortBreakSec = clampValue<uint32_t>(gFocusSettings.shortBreakSec, kFocusMinDurationSec, kFocusMaxDurationSec);
  gFocusSettings.longBreakSec = clampValue<uint32_t>(gFocusSettings.longBreakSec, kFocusMinDurationSec, kFocusMaxDurationSec);
  gFocusSettings.cyclesPerRound = clampValue<uint8_t>(gFocusSettings.cyclesPerRound, 1, 9);
  gFocusSettings.bpm = clampValue<uint16_t>(gFocusSettings.bpm, kFocusMinBpm, kFocusMaxBpm);
  gFocus.remainingSec = gFocusSettings.focusSec;
  gFocus.sessionTotalSec = gFocusSettings.focusSec;
}

void saveFocusSettings() {
  gPrefs.begin(kPrefsFocusNs, false);
  gPrefs.putBool("lamp_link", gFocusSettings.lampSync);
  gPrefs.putChar("lamp_focus", gFocusSettings.lampFocusPreset);
  gPrefs.putChar("lamp_break", gFocusSettings.lampBreakPreset);
  gPrefs.putUInt("focus", gFocusSettings.focusSec);
  gPrefs.putUInt("short", gFocusSettings.shortBreakSec);
  gPrefs.putUInt("long", gFocusSettings.longBreakSec);
  gPrefs.putUChar("cycles", gFocusSettings.cyclesPerRound);
  gPrefs.putBool("auto", gFocusSettings.autoStart);
  gPrefs.putBool("metro", gFocusSettings.metronome);
  gPrefs.putBool("guided_audio", gFocusSettings.guidedAudio);
  gPrefs.putUShort("bpm", gFocusSettings.bpm);
  gPrefs.end();
}

void focusEnterState(FocusState state, bool resetTimer = true) {
  gFocusCompletionTonePending=false;
  gFocus.state = state;
  if (state != FocusState::Paused && state != FocusState::Stopped) {
    gFocus.stateBeforePause = state;
  }
  if (resetTimer) {
    gFocus.sessionTotalSec = focusDurationForState(state);
    gFocus.remainingSec = gFocus.sessionTotalSec;
  }
  gFocus.lastTickMs = millis();
  gFocus.nextMetronomeMs = millis() + 100;
  setStatus(String("Focus ") + focusStateName(state), 1000);
  gPendingFocusCue = state;
  gPendingFocusCueAtMs = millis();
  Serial.printf("[FOCUS] state=%s remain=%u cycle=%u/%u\n",
       focusStateName(state),
       static_cast<unsigned>(gFocus.remainingSec),
       static_cast<unsigned>(gFocus.cycle),
       static_cast<unsigned>(gFocusSettings.cyclesPerRound));
}

void focusStartOrResume() {
  if (gFocus.state == FocusState::Stopped || gFocus.state == FocusState::Paused) gFocusLampLink.allow();
  if (gFocus.state == FocusState::Paused) {
    focusEnterState(gFocus.stateBeforePause, false);
    return;
  }
  if (gFocus.state == FocusState::Stopped) {
    if (gFocus.remainingSec == 0) {
      gFocus.remainingSec = gFocusSettings.focusSec;
    }
    gFocus.sessionTotalSec = gFocus.remainingSec;
    focusEnterState(FocusState::Focus, false);
    return;
  }
  if (focusStateRuns(gFocus.state)) {
    gFocus.stateBeforePause = gFocus.state;
    gFocus.state = FocusState::Paused;
    gFocusCompletionTonePending=false;
    gPendingFocusCue = FocusState::Stopped;
    setStatus("Focus paused", 1000);
    focusTone(523, 90);
  }
}

void focusReset() {
  gFocusCompletionTonePending=false;
  gPendingFocusCue = FocusState::Stopped;
  gFocus.state = FocusState::Stopped;
  gFocus.stateBeforePause = FocusState::Focus;
  gFocus.remainingSec = gFocusSettings.focusSec;
  gFocus.sessionTotalSec = gFocusSettings.focusSec;
  gFocus.lastTickMs = millis();
  setStatus("Focus reset", 1000);
  focusTone(440, 90);
}

void focusSnooze(uint32_t seconds = kFocusSnoozeSec) {
  gFocus.remainingSec = min<uint32_t>(gFocus.remainingSec + seconds, kFocusMaxDurationSec);
  gFocus.sessionTotalSec = max<uint32_t>(gFocus.sessionTotalSec, gFocus.remainingSec);
  setStatus("+5 min", 900);
}

void focusAdvance() {
  FocusState ended = gFocus.state;
  if (ended == FocusState::Focus) {
    ++gFocus.completedToday;
    gFocus.focusedTodaySec += gFocus.sessionTotalSec;
    if ((gFocus.cycle % gFocusSettings.cyclesPerRound) == 0) {
      focusEnterState(FocusState::LongBreak);
    } else {
      focusEnterState(FocusState::ShortBreak);
    }
    return;
  }
  if (ended == FocusState::ShortBreak) {
    ++gFocus.cycle;
    if (gFocusSettings.autoStart) {
      focusEnterState(FocusState::Focus);
    } else {
      gFocus.state = FocusState::Stopped;
      gPendingFocusCue = FocusState::Stopped;
      gFocusCompletionTonePending=true;gPendingFocusCueAtMs=millis();
      gFocus.remainingSec = gFocusSettings.focusSec;
      gFocus.sessionTotalSec = gFocusSettings.focusSec;
      setStatus("Next focus ready", 1200);
    }
    return;
  }
  if (ended == FocusState::LongBreak) {
    focusEnterState(FocusState::Reflect);
    return;
  }
  if (ended == FocusState::Reflect) {
    gFocus.cycle = 1;
    if (gFocusSettings.autoStart) {
      focusEnterState(FocusState::Focus);
    } else {
      gFocus.state = FocusState::Stopped;
      gPendingFocusCue = FocusState::Stopped;
      gFocusCompletionTonePending=true;gPendingFocusCueAtMs=millis();
      gFocus.remainingSec = gFocusSettings.focusSec;
      gFocus.sessionTotalSec = gFocusSettings.focusSec;
      setStatus("Round complete", 1400);
    }
  }
}

void updateFocusTimer() {
  if (!focusStateRuns(gFocus.state)) {
    return;
  }
  uint32_t now = millis();
  if (now < gFocus.lastTickMs) {
    gFocus.lastTickMs = now;
    return;
  }
  uint32_t elapsedSec = (now - gFocus.lastTickMs) / 1000;
  if (elapsedSec == 0) {
    return;
  }
  gFocus.lastTickMs += elapsedSec * 1000;
  if (elapsedSec < gFocus.remainingSec) {
    gFocus.remainingSec -= elapsedSec;
    return;
  }
  gFocus.remainingSec = 0;
  focusAdvance();
}

void serviceFocusMetronome() {
  if (!gFocusSettings.metronome || gFocus.state != FocusState::Focus || gRecording ||
      gPlaybackActive || gSubmitting || gThinking) {
    return;
  }
  uint32_t now = millis();
  if (now < gFocus.nextMetronomeMs) {
    return;
  }
  uint32_t beatMs = 60000UL / max<uint16_t>(1, gFocusSettings.bpm);
  gFocus.nextMetronomeMs = now + beatMs;
  focusTone(660, 35);
}

uint8_t petClampStat(int value) {
  return static_cast<uint8_t>(clampValue<int>(value, 0, 100));
}

uint32_t petEpochNow() {
  if (!hasValidSystemTime()) {
    return 0;
  }
  time_t now = time(nullptr);
  return now > 0 ? static_cast<uint32_t>(now) : 0;
}

const char* petStageName(PetStage stage) {
  switch (stage) {
    case PetStage::Egg:
      return "EGG";
    case PetStage::Baby:
      return "BABY";
    case PetStage::Teen:
      return "TEEN";
    case PetStage::Adult:
      return "ADULT";
    case PetStage::Elder:
    default:
      return "ELDER";
  }
}

const char* petMoodName(PetMood mood) {
  switch (mood) {
    case PetMood::Happy:
      return "HAPPY";
    case PetMood::Hungry:
      return "HUNGRY";
    case PetMood::Bored:
      return "BORED";
    case PetMood::Curious:
      return "CURIOUS";
    case PetMood::Sick:
      return "SICK";
    case PetMood::Excited:
      return "EXCITED";
    case PetMood::Sleepy:
      return "SLEEPY";
    case PetMood::Dirty:
      return "DIRTY";
    case PetMood::Dead:
      return "DEAD";
    case PetMood::Calm:
    default:
      return "CALM";
  }
}

void toggleFocusGuidedAudio() {
  gFocusSettings.guidedAudio=!gFocusSettings.guidedAudio;
  if(!gFocusSettings.guidedAudio && isPomodoroMeditationAssetPath(gPlaybackStreamPath)) {
    stopPlaybackStream();gPlaybackActive=false;
  }
}

void serviceFocusCue() {
  if (gPendingFocusCue == FocusState::Stopped && !gFocusCompletionTonePending) return;
  if (millis()-gPendingFocusCueAtMs > 15000U) {gPendingFocusCue=FocusState::Stopped;gFocusCompletionTonePending=false;return;}
  if (gRecording || gSubmitting || gThinking || gPlaybackActive || gRealtimeActive || gRealtimeExclusiveMode) return;
  if(gFocusCompletionTonePending){gFocusCompletionTonePending=false;focusTone(880,180);return;}
  const FocusState state=gPendingFocusCue;
  gPendingFocusCue=FocusState::Stopped;
  if (!playFocusCue(state)) focusTone(state==FocusState::Focus?1047:state==FocusState::Reflect?659:880,120);
}
