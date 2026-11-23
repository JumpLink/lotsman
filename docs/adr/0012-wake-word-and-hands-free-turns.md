# 12. Wake word and hands-free turns

- Status: **Proposed**
- Date: 2026-11-24
- Deciders: Pascal Garber
- Related: [ADR 0009](0009-voice-as-a-surface.md) (voice as a surface),
  [ADR 0010](0010-conversation-mode.md) (conversation mode; stage 3 is refined here),
  [ADR 0011](0011-language-first-commands-as-shortcuts.md) (confirmation rule),
  [guardrails](../guardrails.md),
  [VibeOS Dictate](https://github.com/pulpoff/vibeos) (`apps/dictate`; prior art, not a dependency)

## Context

Push to talk works (ADR 0010, stage 2): hold F9 or the microphone button, speak, release, and the
text lands in the entry, never sent. `PushToTalk` (`packages/core/src/push-to-talk.ts`) is a state
machine over two ports, `Recorder` and `Transcriber` (`packages/core/src/transcribe.ts`). The app
adapter (`app/src/frontends/gui/dictation-engine.ts`) fills them with `@gjsify/media-capture`
(16 kHz mono F32) and `@gjsify/speech-recognition`'s `transcribe()` with the offline Parakeet model.

The owner wants the next step: say "Hey Computer", then just speak. ADR 0010 names this stage 3
("hands-free: voice activity detection and end-of-turn detection") but fixes neither how Lotsman
notices the start of a turn nor which engines do the work.

What the code has today, and what it lacks:

- **`transcribe()` is one-shot.** It takes a finished buffer or a file and returns text. There is
  no streaming interface, so no partial text and no way to feed a live microphone to a recogniser.
- **`phrases` are ignored.** The adapter forwards the person's term list, but the Parakeet path
  does not use it (the adapter's own comment says so). A runtime key-term context would close that
  gap, so it matters for the engine choice.
- **No voice activity detection and no keyword spotting are bound.** `@gjsify/sherpa-native`
  wraps the offline recogniser only.
- **A running decode cannot be aborted**, and the recorder returns everything at `stop()`.

Prior art: VibeOS's Dictate app listens on the phone with a recogniser interface
(`dictate-recogniser.h`: begin, `hear(samples)` returning finished sentences plus a partial, end),
a turn end after 700 ms of quiet (`TURN_END_MS` in `apps/dictate/src/dictate-engine.c`), a preroll
so the first syllable is not lost, and a rule that a blip without words is not a turn. It loads
its libraries and models lazily and picks a backend per language.

Candidates, with what is known. **Everything marked "vendor" is a vendor claim, not measured by us.**

| Candidate | What it offers | Licence | State of knowledge |
|---|---|---|---|
| sherpa-onnx | Parakeet (in use), keyword spotting, Silero VAD | Apache-2.0 | KWS and VAD exist upstream; **not yet bound** in `@gjsify/sherpa-native` |
| Moonshine | Streaming recognition, German models, runtime key-term context | MIT | German WER Small 7.5 %, Tiny 12 % (**vendor**); VibeOS uses it for German |
| Vosk | Kaldi models, about 50 MB per language, restricted-grammar mode | Apache-2.0 | Restricted grammar is a cheap keyword-spotter candidate (**unverified** for "Hey Computer"); VibeOS uses it only where Moonshine lacks the language |
| openWakeWord | Dedicated wake-word models | Apache-2.0 code; model licences to check | Fallback option only; **unverified** |

Text to speech candidates for later (Moonshine TTS, Kokoro, Piper) need their licence checked
per voice before any is shipped. Nothing here changes ADR 0009's Spiel decision.

## Decision

1. **A wake phrase starts a turn; the user then just speaks.** The phrase ("Hey Computer" first,
   a setting later) is the only new trigger. The rest is the existing voice path: this extends push
   to talk with a **listening** mode and replaces nothing. Push to talk stays, and is the fallback
   whenever listening is off or unavailable.
2. **The pipeline has four steps.**
   1. A tiny, always-on **wake-word detector**, local.
   2. After detection, a **visible cue** (a mandatory sound is not part of the design) and
      recording. **Silero VAD** ends the turn after about 700 ms of quiet, following VibeOS's
      value. A preroll keeps the first syllable. A blip without words is not a turn, which is the
      same rule `PushToTalk` already applies to taps (`minSeconds`, empty text).
   3. The existing gjsify `transcribe()`, later the streaming recogniser (point 5).
   4. The text is **handled like typed text**. An outward action still needs the confirmation of
      ADR 0011 (point 3 and the amendment), and a closed answer such as "yes" may later come by
      voice, under ADR 0010 point 3. Nothing about wake-word turns relaxes either rule.
3. **Privacy rules (hard).**
   - **Off by default; explicit opt-in.** The person turns listening on.
   - **A visible indicator** shows whenever the microphone is open for the detector, not only
     while recording.
   - **No audio leaves the machine and none is stored before the wake word fires.** The detector
     keeps a short ring buffer in memory (for the preroll) and discards it. After the wake word,
     the `voice` policy of ADR 0009 point 4 applies unchanged: a `local-only` profile never reaches
     a cloud engine.
   - **The wake word is muted while Lotsman itself speaks**, so its own voice never triggers it.
     This is the half-duplex rule of ADR 0010 stage 3, applied to the detector as well.
   - **Tests use audio files, never the microphone and never audible output.** The fake recorder
     and fake transcriber pattern of `dictation-hook.ts` carries over; the detector is tested by
     feeding files.
4. **The recogniser layer lives in gjsify** (the core-fix rule). `transcribe()` grows towards a
   **streaming recogniser interface** with several backends behind it, modelled on VibeOS's
   `dictate-recogniser.h`: `begin`, `hear(samples)` returning finished sentences and a partial,
   `end`. Libraries and models load lazily, so a device that never enables listening pays nothing.
   Lotsman's ports (`Recorder`, `Transcriber`) stay; a streaming port is added beside them in
   `@lotsman/core`, and `PushToTalk` is not rewritten.
5. **Engines are decided by measurement, not by vendor numbers.** No backend is chosen by this
   record. The candidates are sherpa-onnx (Parakeet now, KWS and VAD to bind), Moonshine and
   Vosk for recognition; **sherpa KWS and Vosk restricted grammar** are measured against each
   other for the wake word, with openWakeWord as a fallback.
6. **A bench decides, modelled on VibeOS's `talk-bench`.** It feeds recorded files in real time as
   if they were the microphone and measures turn-end latency, WER, time to first answer and RAM.
   Inputs: the owner's ten recordings (ADR 0010 asks for them already), "Hey Computer" samples,
   and **an hour of room tone** for false triggers. The bench uses files only (point 3).
7. **The choice is recorded as an amendment** to this record when step 5 of the order of work is
   done, with the numbers.

## Consequences

- A person can speak to Lotsman with hands off the keyboard, within the privacy rules above. The
  microphone is open for the detector while listening is on, which is why the indicator is not
  optional.
- False triggers and missed triggers are the real cost of a wake word. The room-tone hour measures
  the first; the recordings measure the second. No threshold is accepted without both.
- Echo and self-trigger are handled by muting, not cancelling. A person cannot interrupt Lotsman
  by voice until barge-in (ADR 0010 stage 4) exists.
- The streaming interface is new public surface in gjsify and a second port in `@lotsman/core`;
  both must stay stable once the amendment names a backend.
- Moonshine's runtime key-term context could make the person's term list (ADR 0010 point 9) work
  where Parakeet ignores it today. That is a hope until the bench says so.
- Three recognisers may be bundled as options (Parakeet, Moonshine, Vosk). Each is loaded
  lazily, but each adds a model download and a licence to track.
- The VibeOS values (700 ms, preroll) come from a phone's use. They are starting points for the
  bench, not settled numbers for a desktop.

## Order of work

1. **sherpa KWS and VAD bindings in gjsify**, with tests that read files. Core-fix rule: commit in
   gjsify first, then bump the pointer.
2. **The streaming recogniser interface** in gjsify (`begin`, `hear`, `end`), with the Parakeet
   path as the first backend, then the port in `@lotsman/core`.
3. **Lotsman listening mode**: the switch (off by default), the indicator, the cue, muting while
   Lotsman speaks, the VAD turn end, tested with fakes and files.
4. **The bench** and the **Moonshine and Vosk comparison** on the inputs of point 6.
5. **Record the backend choice** as an amendment to this ADR.
