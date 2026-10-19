# 0.2.182-dev

An unreachable Bridge no longer causes a second synchronous voice connection
on the main loop. The existing connection worker is the only dial attempt.
Failure returns an explicit connection error and preserves the finalized WAV
for a manual retry. Successful RAM and WAV uploads retain their existing
request, response and cleanup behavior. No user request is resent automatically.

The regression executes the actual POST function with failed, unfinished and
disconnected worker results. Its negative control reproduces the former
4,000 + 18,500 ms retry delay; the corrected function performs no fallback
dial. It also verifies exact upload bytes and cleanup on HTTP/storage errors.
This is an injected-clock regression, separate from physical device timing.

On 19 October the public TLS ingress became unreachable while the Bridge
worker remained running. This firmware fixes the device's response to that
network failure; recovery of the external ingress and live voice acceptance
are separate release gates.
