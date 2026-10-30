// Pocket Synth UI/controller: a bounded audio producer feeds the ADV speaker independently of LCD/SD stalls.
namespace {
pocket_synth::Synth gPocketSynth;
bool gSynthOwned=false,gSynthDraining=false,gSynthRequireRelease=true;
uint16_t gSynthPreviousControls=0;
uint32_t gSynthPreviousMask=0,gSynthLastPaint=0;

void synthInvalidate(){gLastRenderMs=0;gUiFramePolicy.invalidate();}
bool synthAudioBusy(){return synth_audio::busy();}
bool stopPocketSynth(){
  const bool stopped=synth_audio::stop();
  gSynthOwned=synth_audio::busy();gSynthDraining=!stopped;
  gPocketSynth.panic();gSynthRequireRelease=true;
  return stopped;
}
void beginPocketSynth(){stopPocketSynth();gSynthPreviousControls=0;gSynthPreviousMask=0;synthInvalidate();}
bool synthForegroundAllowed(){
  return gUiMode==UiMode::PocketSynth&&!gLauncherVisible&&!gChatCommandsVisible&&
    gCanvasSpriteActive&&!gScreensaverActive&&!gScreenOffActive&&!gBootBackgroundActive&&
    !gRecording&&!gSubmitting&&!gThinking&&!gPlaybackActive&&!gVoiceNoticeVisible&&
    !gTransferUiActive&&!gOtaApplyInProgress&&!gPendingRestart&&
    !gInboxHttpBusy&&!gVoiceDialBusy&&!gVoiceReplySpeechBusy&&gQueuedVoiceReplySpeech.isEmpty()&&
    !gRealtimeActive&&!gRealtimeDialBusy&&!gRealtimeExclusiveMode&&!gPendingRealtimeStart&&
    !gMeshBusOwned&&!radioBusy()&&!vlcBusy()&&!gTextTurnTaskHandle&&!gCompletedTextTurn&&
    gPendingTextTurns.empty()&&gActiveTextTurn.isEmpty()&&!gG0VoicePending&&
    !gVoiceCapturePreparing&&!gPendingOtaCheckAction&&!gPendingOtaApplyAction&&!gAlarmRinging;
}
uint32_t synthKeyMask(const Keyboard_Class::KeysState& keys){
  uint32_t mask=0;for(char c:keys.word){int index=pocket_synth::keyIndex(c);if(index>=0)mask|=uint32_t(1)<<index;}return mask;
}
uint16_t synthControls(const Keyboard_Class::KeysState& keys){
  uint16_t c=keys.space?1:0;if(keys.enter)c|=2;if(keys.del)c|=4;
  for(char k:keys.word)switch(k){case '[':case '{':c|=8;break;case ']':case '}':c|=16;break;
    case '-':case '_':c|=32;break;case '=':case '+':c|=64;break;
    case ',':case '<':c|=128;break;case '.':case '>':c|=256;break;default:break;}return c;
}
bool handlePocketSynthKey(char,const Keyboard_Class::KeysState&){
  // Chords and release edges use the entire key snapshot below, not the chat
  // input path's first character or OS-style repeat events. Globals run first.
  return true;
}
void servicePocketSynth(){
  if(gSynthDraining){if(synth_audio::busy())return;gSynthDraining=false;gSynthOwned=false;}
  if(gUiMode!=UiMode::PocketSynth){if(synth_audio::busy())stopPocketSynth();return;}
  if(gSynthOwned&&synth_audio::status().fault){
    stopPocketSynth();setStatus("Synth stopped safely; release keys",1400);return;
  }
  const auto&keys=gKeyboardState;const uint32_t mask=synthKeyMask(keys);const uint16_t controls=synthControls(keys);
  const bool modifier=keys.ctrl||keys.alt||keys.opt||keys.fn||keys.tab;
  if(!synthForegroundAllowed()||modifier||hasHidKey(keys,kHidKeyEscape)){
    stopPocketSynth();gSynthPreviousControls=controls;gSynthPreviousMask=mask;return;
  }
  if(gSynthRequireRelease){
    gSynthPreviousControls=controls;gSynthPreviousMask=mask;
    if(mask==0&&controls==0)gSynthRequireRelease=false;
    return;
  }
  // A foreign notification owns the speaker until completely finished.
  if(!gSynthOwned&&M5Cardputer.Speaker.isPlaying()){
    gSynthRequireRelease=true;gSynthPreviousControls=controls;gSynthPreviousMask=mask;return;
  }
  const uint16_t edge=controls&~gSynthPreviousControls;gSynthPreviousControls=controls;
  bool changed=edge!=0||mask!=gSynthPreviousMask;gSynthPreviousMask=mask;
  if(edge&4){stopPocketSynth();synthInvalidate();return;}
  if(edge&8)gPocketSynth.nextPatch(-1);if(edge&16)gPocketSynth.nextPatch(1);
  if(edge&32)gPocketSynth.nextOctave(-1);if(edge&64)gPocketSynth.nextOctave(1);
  if(edge&(8|16|32|64)){
    stopPocketSynth();synthInvalidate();return; // held keys cannot transpose/retrigger unexpectedly
  }
  if(edge&1)gPocketSynth.setSustain(!gPocketSynth.sustain);
  if(edge&2)gPocketSynth.nextLesson();
  if(edge&128)gPocketSynth.gain=max(0,gPocketSynth.gain-10);
  if(edge&256)gPocketSynth.gain=min(100,gPocketSynth.gain+10);
  if(gPocketSynth.sync(mask))changed=true;
  if(mask){gLastUserActivityMs=millis();gLastUserInputMs=millis();}
  if(changed)synthInvalidate();
  synth_audio::Control control;
  control.mask=mask;control.octave=gPocketSynth.octave;control.gain=gPocketSynth.gain;
  control.patch=gPocketSynth.patch;control.sustain=gPocketSynth.sustain;
  if(synth_audio::busy())synth_audio::update(control);
  else if(mask){
    if(!synth_audio::start(control)){
      stopPocketSynth();setStatus("ADV audio unavailable; release keys",1400);return;
    }
  }
  gSynthOwned=synth_audio::busy();
  if(synth_audio::status().fault){stopPocketSynth();setStatus("Synth stopped safely; release keys",1400);return;}

  if(millis()-gSynthLastPaint>=80){gSynthLastPaint=millis();synthInvalidate();}
}

void renderPocketSynthUi(){
  auto&d=gCanvas;const uint16_t bg=rgb565_local(5,11,20),panel=rgb565_local(12,22,35);
  const uint16_t ink=rgb565_local(12,20,30),white=rgb565_local(211,222,231);
  const uint16_t mint=rgb565_local(75,239,200),amber=rgb565_local(255,186,75),muted=rgb565_local(148,169,190);
  d.fillScreen(bg);d.setFont(&fonts::Font0);d.setTextColor(mint,bg);d.setCursor(6,3);d.print("POCKET SYNTH");
  d.setTextColor(white,bg);d.setCursor(90,3);d.print(pocket_synth::patchName(gPocketSynth.patch));
  char text[40];snprintf(text,sizeof(text),"%d%%",gPocketSynth.gain);d.setCursor(208,3);d.print(text);
  snprintf(text,sizeof(text),"C%d-C%d  %s",gPocketSynth.octave,gPocketSynth.octave+2,gPocketSynth.sustain?"SUSTAIN":"KEY HOLD");
  d.setCursor(6,15);d.setTextColor(muted,bg);d.print(text);
  char note[8];pocket_synth::noteName(gPocketSynth.lastMidi,note,sizeof(note));
  snprintf(text,sizeof(text),"%s %d/6",note,synth_audio::status().voices);d.setCursor(176,15);d.print(text);
  d.fillRoundRect(5,27,230,16,3,panel);d.setTextColor(amber,panel);d.setCursor(9,31);
  if(gPocketSynth.lesson==pocket_synth::Lesson::Free)d.print("FREE PLAY  / Enter: scale coach");
  else{
    const int target=gPocketSynth.targetKey();pocket_synth::noteName(gPocketSynth.midiFor(target),note,sizeof(note));
    snprintf(text,sizeof(text),"%s > %s [%c]",pocket_synth::lessonName(gPocketSynth.lesson),note,char(toupper(pocket_synth::kKeyMap[target])));d.print(text);
  }
  // Fifteen white keys = C..B, C..B, C; black keys at the true semitone gaps.
  int whiteIndex=0;int whitePos[25]={};
  for(int i=0;i<25;++i){int pc=i%12;if(pc==1||pc==3||pc==6||pc==8||pc==10)continue;
    int x=7+whiteIndex*15;whitePos[i]=x;
    bool down=(gPocketSynth.heldMask&(uint32_t(1)<<i))!=0;
    const uint16_t tile=down?mint:white;d.fillRect(x,47,14,51,tile);
    if(gPocketSynth.lesson!=pocket_synth::Lesson::Free&&i==gPocketSynth.targetKey())d.fillRect(x+2,92,10,4,amber);
    char label[2]={char(toupper(pocket_synth::kKeyMap[i])),0};d.setTextColor(ink,tile);d.setCursor(x+4,79);d.print(label);
    if(pc==0){snprintf(text,sizeof(text),"C%d",gPocketSynth.octave+i/12);d.setCursor(x+1,89);d.print(text);}++whiteIndex;
  }
  for(int i=0;i<25;++i){int pc=i%12;if(!(pc==1||pc==3||pc==6||pc==8||pc==10))continue;
    int x=whitePos[i-1]+10;bool down=(gPocketSynth.heldMask&(uint32_t(1)<<i))!=0;
    const uint16_t tile=down?mint:ink;d.fillRect(x,47,9,28,tile);
    char label[2]={char(toupper(pocket_synth::kKeyMap[i])),0};d.setTextColor(down?ink:white,tile);d.setCursor(x+1,62);d.print(label);
    if(gPocketSynth.lesson!=pocket_synth::Lesson::Free&&i==gPocketSynth.targetKey())d.fillRect(x+1,72,7,2,amber);
  }
  d.setTextColor(muted,bg);d.setCursor(6,103);d.print("-/+ Oct  [/] Sound  ,/. Volume");
  d.setCursor(6,114);d.print("Space sustain  Backspace silence");
  d.setCursor(6,125);d.print(gSynthRequireRelease?"Release keys to play":"Tab menu  Esc exit  Ctrl+V voice");
}
} // namespace
