"""Static integration fences supplement executable C++/Bridge tests."""
from pathlib import Path
p=Path(__file__).resolve().parents[1]/'src'/'main_parts'
part=lambda n:(p/f'{n:03}_main.cpp.inc').read_text()
assert 'kMicSampleRate = 24000' in part(1)
assert 'kRecordChunkSamples = 1024' in part(1)  # 42.7ms, same fixed RAM
assert 'kRealtimeInputSampleRate = 24000' in part(1)
assert 'kRealtimePlaybackPrebufferBytes = 4 * 1024' in part(1)
assert part(17).index('apply blocked before reboot') < part(17).index('requestOtaApplyBootMode(')
assert part(17).count('release_delivery::otaPowerAllowed') == 2
assert 'modeChanged && mode == UiMode::Ota' in part(24)
assert 'gPendingOtaCheckAction = true' in part(24)
assert 'gUiMode == UiMode::Ota' in part(20)
assert 'gVoiceReplyPending ? 4000U' in part(20)
assert 'seq > gVoiceReplyAfterSeq' in part(20)
pending=part(39).split('if (resp["pending"] | false) {',1)[1].split('gVoiceReplyPending = false;',1)[0]
assert 'return true;' in pending and 'requestAndPlayTts(' not in pending
assert 'replySeq > gInboxLastSeq' in part(39)
assert 'gOtaManifest.version != gOtaNotifiedVersion' in part(15)
assert 'focusTone(1320, 120)' not in part(15)
assert 'drawSmoothUncannyEye' in part(50) and 'pushImage' not in part(50)
assert not (p / 'uncanny_default_eye.h').exists()  # no RGB565 bitmap upload path remains
print('PASS release wiring (17 fences: G0, OTA, inbox, eyes; Realtime PCM unchanged)')
