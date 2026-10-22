// Meshtastic leaf mode owns EXT SPI while active. No radio at ordinary boot.
namespace {

bool handleMeshEscape() {
  if(gUiMode!=UiMode::Mesh || gLauncherVisible)return false;
  if(gMeshSession && gMeshSession->state.detailView) {gMeshSession->state.detailView=false;return true;}
  if(stopMeshMode(true))setUiMode(UiMode::Home);
  return true;
}

bool meshBlocksMode(UiMode mode) {
  switch(mode) {
    case UiMode::Voice: case UiMode::Library: case UiMode::AudioFolders:
    case UiMode::Notes: case UiMode::Assets: case UiMode::Files:
    case UiMode::Nes: case UiMode::RfidLab: case UiMode::Sonar:
      return true;
    default:return false;
  }
}

bool meshStartIsBusy() {
  return radioBusy() || gBootBackgroundActive || gRecording || gSubmitting || gThinking || gPlaybackActive ||
    gTransferUiActive || gOtaApplyInProgress || gInboxHttpBusy || gVoiceDialBusy ||
    gVoiceReplySpeechBusy || !gQueuedVoiceReplySpeech.isEmpty() ||
    gRealtimeActive || gRealtimeDialBusy || gRealtimeExclusiveMode || gPendingRealtimeStart ||
    gTextTurnTaskHandle || gCompletedTextTurn || !gPendingTextTurns.empty() ||
    !gActiveTextTurn.isEmpty() || gG0VoicePending || gVoiceCapturePreparing;
}

// Touch only P0; never reset the I2C bus, expander or the other seven pins.
bool meshCapBit(uint8_t reg, bool value) {
  uint8_t byte=0;
  if(!gMeshCapBus || !gMeshCapBus->readRegister(0x43,reg,&byte,1,100000)) return false;
  byte=value ? uint8_t(byte|1) : uint8_t(byte&~1);
  return gMeshCapBus->writeRegister8(0x43,reg,byte,100000);
}

void meshRestoreCap() {
  if(gMeshCapBitsSaved) {
    meshCapBit(0x05,gMeshCapBits[1]);
    meshCapBit(0x03,gMeshCapBits[0]);
    meshCapBit(0x07,gMeshCapBits[2]);
  }
  gMeshCapBitsSaved=false;gMeshCapBus=nullptr;
}

bool meshEnableCap() {
  m5::I2C_Class* candidates[]={&m5::In_I2C,&m5::Ex_I2C};
  for(auto* bus:candidates) {
    if(!bus->isEnabled() || bus->getSDA()!=8 || bus->getSCL()!=9)continue;
    uint8_t bits[3]={};
    if(!bus->readRegister(0x43,0x03,&bits[0],1,100000) ||
       !bus->readRegister(0x43,0x05,&bits[1],1,100000) ||
       !bus->readRegister(0x43,0x07,&bits[2],1,100000))continue;
    gMeshCapBus=bus;gMeshCapBitsSaved=true;
    for(size_t i=0;i<3;++i)gMeshCapBits[i]=bits[i]&1;
    if(meshCapBit(0x05,true) && meshCapBit(0x03,true) && meshCapBit(0x07,false))return true;
    meshRestoreCap();return false;
  }
  return false;
}

bool loadMeshIdentity(s1_mesh::RadioSession& session) {
  uint8_t identity[64]={}, regenerated[32]={};
  Preferences prefs;
  if(!prefs.begin("s1mesh",false))return false;
  bool loaded=prefs.getBytesLength("identity")==sizeof(identity) &&
    prefs.getBytes("identity",identity,sizeof(identity))==sizeof(identity);
  bool valid=loaded && libmeshtastic_leaf::MeshCryptoPKI::isUsablePublicKey(identity) &&
    libmeshtastic_leaf::MeshCryptoPKI::regeneratePublicKey(regenerated,identity+32) &&
    memcmp(regenerated,identity,32)==0;
  if(!valid) {
    valid=libmeshtastic_leaf::libmeshtastic_leaf::generateKeyPair(identity,identity+32) &&
      prefs.putBytes("identity",identity,sizeof(identity))==sizeof(identity);
  }
  prefs.end();
  if(valid) {
    session.mesh.setMyPublicKey(identity);
    session.mesh.setMyPrivateKey(identity+32);
  }
  volatile uint8_t* wipe=identity;
  for(size_t i=0;i<sizeof(identity);++i)wipe[i]=0;
  return valid;
}

void meshRadioInitTask(void* pointer) {
  auto* session=static_cast<s1_mesh::RadioSession*>(pointer);
  const int result=session->initialize();
  session->initResult.store(result,std::memory_order_release);
  vTaskDelete(nullptr); // No session access after publishing the result.
}

bool stopMeshMode(bool goHome) {
  if(!gMeshBusOwned)return true;
  if(gMeshSession && gMeshSession->initResult.load(std::memory_order_acquire)==s1_mesh::kInitPending) {
    gMeshCancelStart=true;gMeshExitAfterStop|=goHome;gMeshNotice="Stopping radio...";
    return false;
  }
  if(gMeshSession && gMeshSession->readyReported)logf("[MESH] session min_heap=%u min_largest=%u",
    unsigned(gMeshSession->lowHeap),unsigned(gMeshSession->lowLargest));
  gMeshSession.reset(); // Clears the IRQ callback and sleeps before SD resumes.
  digitalWrite(kRfidCsPin,HIGH);
  meshRestoreCap();
  gMeshBusOwned=false;gMeshCancelStart=false;gMeshExitAfterStop=false;
  gSdReady=mountSdCardOnSharedSpi();
  gStorageReady=gLittleFsReady || gSdReady;
  gMeshNotice=gSdReady ? "Radio off / SD ready" : "Radio off / SD unavailable";
  logf("[MESH] stopped sd=%d heap=%u",gSdReady,unsigned(ESP.getFreeHeap()));
  return true;
}

void startMeshMode() {
  if(gMeshBusOwned)return;
  if(meshStartIsBusy()) {gMeshNotice="Finish current task first";return;}
  if(!gCanvasSpriteActive) {gMeshNotice="Display buffer recovering";return;}
  if(ESP.getFreeHeap()<65536 || heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)<24576) {
    gMeshNotice="Not enough free RAM";return;
  }
  // Busy/heap failures leave SD and radio untouched.
  gMeshSession.reset(new(std::nothrow) s1_mesh::RadioSession(gSdSpi));
  if(!gMeshSession) {gMeshNotice="Not enough free RAM";return;}
  gMeshNotice="Preparing radio...";render();
  if(!loadMeshIdentity(*gMeshSession)) {
    gMeshSession.reset();gMeshNotice="Identity storage failed";return;
  }
  if(!meshEnableCap()) {
    gMeshSession.reset();gMeshNotice="Cap-1262 not detected";return;
  }
  gMeshBusOwned=true;gMeshCancelStart=false;gMeshExitAfterStop=false;gMeshNoticeUntilMs=0;
  gSdReady=false;gStorageReady=false;
  SD.end();
  digitalWrite(kSdCsPin,HIGH);pinMode(kSdCsPin,OUTPUT);
  digitalWrite(kRfidCsPin,HIGH);pinMode(kRfidCsPin,OUTPUT);
  gSdSpi.begin(kSdSckPin,kSdMisoPin,kSdMosiPin,kSdCsPin);
  gMeshNotice="Starting / SD paused";
  if(xTaskCreate(meshRadioInitTask,"mesh-init",8192,gMeshSession.get(),1,nullptr)!=pdPASS) {
    gMeshSession->initResult.store(RADIOLIB_ERR_UNKNOWN,std::memory_order_release);
    stopMeshMode(false);gMeshNotice="Radio task allocation failed";
  }
}

void meshHandlePacket(const libmeshtastic_leaf::MeshPacket& packet) {
  if(!gMeshSession || packet.header.from==gMeshSession->mesh.getNodeNum())return;
  auto& state=gMeshSession->state;
  auto* node=state.hear(packet.header.from,millis(),packet.rxRssi);
  if(packet.portNum==meshtastic_PortNum_NODEINFO_APP && node) {
    meshtastic_User user=meshtastic_User_init_zero;
    auto stream=pb_istream_from_buffer(packet.payload,packet.payloadLen);
    if(pb_decode(&stream,meshtastic_User_fields,&user)) {
      const char* name=user.long_name[0] ? user.long_name : user.short_name;
      s1_mesh::copyText(node->name,sizeof(node->name),reinterpret_cast<const uint8_t*>(name),strlen(name));
    }
  }
  if(packet.portNum==meshtastic_PortNum_TEXT_MESSAGE_APP && packet.payloadLen) {
    state.message(packet.header.from,packet.header.id,false,packet.payload,packet.payloadLen);
    // Received radio text is display data, never an AI/device command.
  }
}

void serviceMeshMode() {
  if(!gMeshBusOwned || !gMeshSession)return;
  const int result=gMeshSession->initResult.load(std::memory_order_acquire);
  if(result==s1_mesh::kInitPending)return;
  if(result || gMeshCancelStart) {
    const bool home=gMeshExitAfterStop;
    stopMeshMode(false);
    if(result)gMeshNotice="Radio init failed: "+String(result);
    if(home)setUiMode(UiMode::Home);
    return;
  }
  auto& session=*gMeshSession;
  session.lowHeap=std::min(session.lowHeap,uint32_t(ESP.getFreeHeap()));
  session.lowLargest=std::min(session.lowLargest,uint32_t(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)));
  if(!session.readyReported) {
    session.readyReported=true;
    logf("[MESH] ready TH LongFast 923.875MHz node=!%08lx heap=%u largest=%u",
      static_cast<unsigned long>(session.mesh.getNodeNum()),unsigned(session.lowHeap),unsigned(session.lowLargest));
  }
  session.mesh.onReceive(meshHandlePacket);
  session.mesh.update();
  if(!gMeshNoticeUntilMs || int32_t(millis()-gMeshNoticeUntilMs)>=0)gMeshNotice="Listening / SD paused";
}

bool meshSendInput() {
  if(!gMeshSession || gMeshSession->initResult.load(std::memory_order_acquire)!=0 || gMeshCancelStart)return false;
  auto& s=*gMeshSession;
  if(!s.state.input[0])return true;
  const uint32_t id=s.mesh.sendText(s.state.input);
  if(!id) {gMeshNotice="Radio busy / duty limit";gMeshNoticeUntilMs=millis()+2000;return false;}
  s.state.message(s.mesh.getNodeNum(),id,true,reinterpret_cast<uint8_t*>(s.state.input),strlen(s.state.input));
  s.state.input[0]=0;s.state.historyOffset=0;s.state.detailView=false;s.state.nodeView=false;
  gMeshNotice="Queued; delivery unknown";gMeshNoticeUntilMs=millis()+2000;
  return true;
}

bool handleMeshKey(char key,const Keyboard_Class::KeysState& keys) {
  if(keys.ctrl && (key=='r'||key=='R'||key=='v'||key=='V')) {setStatus("Esc exits Mesh for voice",1600);return true;}
  if(keys.ctrl && key!='n' && key!='N' && key!='o' && key!='O')return false;
  if(!gMeshSession) {
    if(keys.enter || key=='\r' || key=='\n')startMeshMode();
    return true;
  }
  auto& state=gMeshSession->state;
  if(keys.ctrl && (key=='n'||key=='N')) {state.nodeView=!state.nodeView;state.detailView=false;return true;}
  if(keys.ctrl && (key=='o'||key=='O')) {state.detailView=!state.detailView;state.nodeView=false;return true;}
  if(key==1 || key==2) {
    if(state.nodeView) {
      const size_t pages=(state.nodeCount+1)/2;
      if(pages)state.nodePage=(state.nodePage+(key==1?pages-1:1))%pages;
    } else if(state.messageCount) {
      state.historyOffset=(state.historyOffset+(key==1?1:state.messageCount-1))%state.messageCount;
    }
    return true;
  }
  if(keys.enter || key=='\r' || key=='\n') {meshSendInput();return true;}
  if(keys.del || key=='\b') {state.erase();return true;}
  if(key>=32 && key<127) {
    const String text=translateInputChar(key);
    state.append(text.c_str());state.detailView=false;state.nodeView=false;
  }
  return true;
}

bool handleMeshHostCommand(const String& line) {
  if(!line.startsWith("mesh."))return false;
  if(line=="mesh.open")setUiMode(UiMode::Mesh);
  else if(line=="mesh.start") {setUiMode(UiMode::Mesh);if(gUiMode==UiMode::Mesh)startMeshMode();}
  else if(line=="mesh.stop") {if(stopMeshMode(true))setUiMode(UiMode::Home);}
  else if(line=="mesh.nodes") {if(gMeshSession)gMeshSession->state.nodeView=true;}
  else if(line=="mesh.status") {
    logf("[MESH] owned=%d init=%d sd=%d heap=%u largest=%u nodes=%u messages=%u",gMeshBusOwned,
      gMeshSession?gMeshSession->initResult.load():s1_mesh::kInitPending,gSdReady,unsigned(ESP.getFreeHeap()),
      unsigned(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)),
      unsigned(gMeshSession?gMeshSession->state.nodeCount:0),unsigned(gMeshSession?gMeshSession->state.messageCount:0));
  }
  return true;
}

String meshClip(const String& source,int width) {
  String text=source;
  while(!text.isEmpty() && gCanvas.textWidth(text)>width)removeLastUtf8Char(text);
  return text;
}
String meshNodeName(uint32_t id) {
  if(gMeshSession)for(size_t i=0;i<gMeshSession->state.nodeCount;++i) {
    const auto& n=gMeshSession->state.nodes[i];if(n.id==id && n.name[0])return String(n.name);
  }
  char label[12];snprintf(label,sizeof(label),"!%08lx",static_cast<unsigned long>(id));return String(label);
}

void renderMeshUi() {
  auto& d=gCanvas;
  const uint16_t bg=rgb565_local(3,8,14),muted=rgb565_local(130,145,155),cyan=rgb565_local(47,227,255);
  d.fillScreen(bg);d.setTextSize(1);d.setFont(&fonts::Font2);d.setTextColor(TFT_WHITE,bg);d.setCursor(8,5);d.print("Mesh");
  d.setFont(&fonts::Font0);d.setTextColor(muted,bg);d.setCursor(144,12);d.print("TH / LongFast");
  d.drawFastHLine(6,23,228,rgb565_local(48,54,61));
  d.setTextColor(gMeshBusOwned?rgb565_local(255,136,64):muted,bg);d.setCursor(8,29);
  d.print(meshClip(gMeshNotice.isEmpty()?(gSdReady?"Radio off / SD ready":"Radio off / SD unavailable"):gMeshNotice,224));
  if(!gMeshSession || gMeshSession->initResult.load(std::memory_order_acquire)!=0) {
    d.setFont(&fonts::Font2);d.setTextColor(TFT_WHITE,bg);d.setCursor(36,58);d.print("Meshtastic leaf");
    d.setFont(&fonts::Font0);d.setTextColor(muted,bg);d.setCursor(78,81);d.print("Public channel");
    d.setTextColor(cyan,bg);d.setCursor(8,127);d.print(gMeshBusOwned?"Starting...  Esc cancel":"Enter start   Esc back");return;
  }
  const auto& state=gMeshSession->state;
  if(state.nodeView) {
    d.setTextColor(cyan,bg);d.setCursor(8,44);d.print("NODES HEARD: ");d.print(state.nodeCount);
    for(size_t row=0;row<2;++row) {
      const size_t i=state.nodePage*2+row;if(i>=state.nodeCount)break;
      const auto& n=state.nodes[i];const int y=59+int(row)*31;
      d.setFont(&fonts::efontCN_12);d.setTextColor(TFT_WHITE,bg);d.setCursor(8,y);d.print(meshClip(meshNodeName(n.id),166));
      d.setFont(&fonts::Font0);d.setTextColor(rgb565_local(88,240,141),bg);String rssi=String(n.rssi)+" dBm";d.setCursor(232-min<int>(56,d.textWidth(rssi)),y+4);d.print(meshClip(rssi,56));
      d.setTextColor(muted,bg);d.setCursor(8,y+17);d.printf("!%08lx / %lus",static_cast<unsigned long>(n.id),static_cast<unsigned long>((millis()-n.seen)/1000));
    }
    d.setFont(&fonts::Font0);d.setTextColor(muted,bg);d.setCursor(8,127);d.print("Up/Down page C-N chat Esc stop");return;
  }
  if(state.detailView && state.messageCount) {
    const auto& m=state.messages[state.messageCount-1-state.historyOffset];
    d.setTextColor(cyan,bg);d.setCursor(8,42);d.print(meshClip(m.outgoing?"You / queued":meshNodeName(m.from),224));
    d.setFont(&fonts::efontCN_12);d.setTextColor(TFT_WHITE,bg);d.setClipRect(8,54,224,72);
    String line;line.reserve(s1_mesh::kTextBytes);String text(m.text);int y=54;
    for(size_t i=0;i<text.length();) {
      size_t end=i+1;while(end<text.length() && (uint8_t(text[end])&0xc0)==0x80)++end;
      const String glyph=text.substring(i,end);
      if(!line.isEmpty() && d.textWidth(line+glyph)>224) {d.setCursor(8,y);d.print(line);y+=12;line=glyph;} else line+=glyph;
      i=end;
    }
    d.setCursor(8,y);d.print(line);d.clearClipRect();
    d.setFont(&fonts::Font0);d.setTextColor(muted,bg);d.setCursor(8,127);d.print("Up/Down message C-O back");return;
  }
  if(!state.messageCount) {
    d.setFont(&fonts::Font2);d.setTextColor(TFT_WHITE,bg);d.setCursor(56,59);d.print("Listening...");
    d.setFont(&fonts::Font0);d.setTextColor(muted,bg);d.setCursor(66,82);d.print("No nodes heard yet");
  } else for(size_t row=0;row<2;++row) {
    const int index=int(state.messageCount)-2+int(row)-int(state.historyOffset);if(index<0)continue;
    const auto& m=state.messages[size_t(index)];const int y=44+int(row)*31;
    d.setFont(&fonts::Font0);d.setTextColor(m.outgoing?rgb565_local(157,102,255):cyan,bg);d.setCursor(8,y);
    d.print(meshClip(m.outgoing?"You / queued":meshNodeName(m.from),224));
    d.setFont(&fonts::efontCN_12);d.setTextColor(TFT_WHITE,bg);d.setCursor(8,y+10);d.print(meshClip(String(m.text),224));
  }
  d.drawRect(5,108,230,17,rgb565_local(52,64,74));d.setFont(&fonts::efontCN_12);d.setTextColor(TFT_WHITE,bg);d.setCursor(10,110);
  String composer=state.input[0]?String(state.input):String("> Message...");
  while(!composer.isEmpty() && d.textWidth(composer)>220) {
    size_t n=1;while(n<composer.length() && (uint8_t(composer[n])&0xc0)==0x80)++n;composer.remove(0,n);
  }
  d.print(composer);
  d.setFont(&fonts::Font0);d.setTextColor(muted,bg);d.setCursor(8,127);d.print("Enter send C-N nodes C-O read");
}
} // namespace
