// Silent local Snake; no SD, audio, network or task ownership.
namespace {
snake_game::Game gSnake;
void snakeChanged(){gLastRenderMs=0;gUiFramePolicy.invalidate();}
void pauseSnake(){
  if(gSnake.phase==snake_game::Phase::Playing){gSnake.pause();snakeChanged();}
}
void beginSnake(){
  if(!gSnake.initialized)gSnake.reset(esp_random(),millis());
  snakeChanged();
}
bool snakeBlocked(){
  return gUiMode!=UiMode::Snake||gLauncherVisible||gChatCommandsVisible||
    gScreensaverActive||gScreenOffActive||gRecording||gSubmitting||gThinking||gPlaybackActive||
    gVoiceNoticeVisible||gVoiceReplySpeechBusy||gVoiceCapturePreparing||gG0VoicePending||
    gTransferUiActive||gOtaApplyInProgress||gPendingRestart||gInboxHttpBusy||gVoiceDialBusy||
    gRealtimeActive||gRealtimeExclusiveMode||gRealtimeDialBusy||gPendingRealtimeStart||
    gBootBackgroundActive||gMeshBusOwned||gTextTurnTaskHandle||gCompletedTextTurn||
    !gPendingTextTurns.empty()||!gQueuedVoiceReplySpeech.isEmpty()||radioBusy()||vlcBusy();
}
void serviceSnake(){
  if(!gSnake.initialized)return;
  if(snakeBlocked()){pauseSnake();return;}
  if(gSnake.phase==snake_game::Phase::Playing){
    // Keep the board awake during play, without faking a real-key/network timestamp.
    gLastUserActivityMs=millis();
    if(gSnake.tick(millis()))snakeChanged();
  }
}
bool handleSnakeKey(char key,const Keyboard_Class::KeysState& keys){
  beginSnake();
  if(keys.ctrl||keys.alt||keys.opt)return true; // ADV arrows retain the Fn modifier
  if(snakeBlocked())return true;
  const char c=char(tolower(static_cast<unsigned char>(key)));
  using snake_game::Direction;using snake_game::Phase;
  if(c=='n'){gSnake.reset(esp_random(),millis());}
  else if(keys.enter||key=='\r'||key=='\n'||key==' '||c=='p'){
    if(gSnake.phase==Phase::Lost||gSnake.phase==Phase::Won){gSnake.reset(esp_random(),millis());}
    gSnake.toggle(millis());
  }
  else if(c=='w'||key==';')gSnake.turn(Direction::Up);
  else if(c=='s'||key=='.')gSnake.turn(Direction::Down);
  else if(c=='a'||key==',')gSnake.turn(Direction::Left);
  else if(c=='d'||key=='/')gSnake.turn(Direction::Right);
  snakeChanged();return true;
}
void renderSnakeUi(){
  beginSnake();auto&d=gCanvas;using snake_game::Phase;
  const uint16_t bg=rgb565_local(5,11,20),grid=rgb565_local(15,29,38),muted=rgb565_local(147,170,188);
  const uint16_t mint=rgb565_local(81,241,194),body=rgb565_local(37,155,136),amber=rgb565_local(255,180,72);
  const uint16_t red=rgb565_local(242,86,107),panel=rgb565_local(10,22,33),white=rgb565_local(222,237,241);
  d.fillScreen(bg);d.setFont(&fonts::Font0);d.setTextColor(mint,bg);d.setCursor(8,4);d.print("SNAKE");
  char text[32];snprintf(text,sizeof(text),"Score %u",unsigned(gSnake.score()));d.setCursor(65,4);d.setTextColor(white,bg);d.print(text);
  snprintf(text,sizeof(text),"Best %u",unsigned(gSnake.best));d.setCursor(157,4);d.setTextColor(amber,bg);d.print(text);
  d.drawRect(7,18,226,98,grid);
  for(uint16_t i=0;i<gSnake.length;++i){
    const int x=8+(gSnake.body[i]%snake_game::kWidth)*8,y=19+(gSnake.body[i]/snake_game::kWidth)*8;
    d.fillRect(x,y,7,7,i?body:mint);
    if(i==0){
      const auto dir=gSnake.direction;
      const bool vertical=dir==snake_game::Direction::Up||dir==snake_game::Direction::Down;
      const int ex=dir==snake_game::Direction::Right?5:dir==snake_game::Direction::Left?1:2;
      const int ey=dir==snake_game::Direction::Down?5:dir==snake_game::Direction::Up?1:2;
      d.fillRect(x+ex,y+ey,1,1,bg);d.fillRect(x+ex+(vertical?3:0),y+ey+(vertical?0:3),1,1,bg);
    }
  }
  if(gSnake.food<snake_game::kCells){
    int x=8+(gSnake.food%snake_game::kWidth)*8,y=19+(gSnake.food/snake_game::kWidth)*8;
    d.fillRect(x+1,y+1,5,5,amber);d.fillRect(x+3,y,2,1,mint);
  }
  if(gSnake.phase!=Phase::Playing){
    d.fillRoundRect(43,46,154,44,5,panel);d.drawRect(46,49,148,38,grid);
    const char* title=gSnake.phase==Phase::Ready?"READY TO SNAKE":gSnake.phase==Phase::Paused?"PAUSED":gSnake.phase==Phase::Won?"BOARD CLEARED!":"GAME OVER";
    d.setTextColor(gSnake.phase==Phase::Lost?red:mint,panel);d.setCursor(55,55);d.print(title);
    d.setTextColor(white,panel);d.setCursor(55,72);d.print(gSnake.phase==Phase::Paused?"Enter: resume":"Enter: play");
  }
  d.setTextColor(muted,bg);d.setCursor(8,122);d.print("WASD/arrows P pause N new Tab menu");
  renderLauncherOverlay();renderDebugOverlay();
}
} // namespace
