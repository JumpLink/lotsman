# 11. Language first, commands as shortcuts

- Status: **Accepted**
- Date: 2026-11-21
- Deciders: Pascal Garber
- Related: [ADR 0003](0003-serve-tasks-questions-channel.md) (questions and the channel),
  [ADR 0007](0007-profiles-tasks-triggers.md) (tasks; the shared command code),
  [ADR 0008](0008-messenger-channel-as-mcp-contract.md) (the messenger, `/ask`),
  [ADR 0009](0009-voice-as-a-surface.md) and [ADR 0010](0010-conversation-mode.md) (voice),
  [guardrails](../guardrails.md),
  [VibeOS, "The Phone That Listens"](https://vibeos.top/idea) (MIT; inspiration for the principles)

## Context

Today the person steers Lotsman with words it must know exactly. In the messenger, `receive.ts`
matches `/run`, `/tasks` and `/status` with one regular expression before anything else and
answers them without a model call. `/ask` (the prefix is a setting, `requests.prefix`) turns the
rest of a message into a request for the agent; a plain message continues the last session or
answers an open question. The CLI offers the same functions as `lotsman run`, `tasks` and `status`.
The logic is already one implementation for both surfaces
(`app/src/frontends/cli/task-commands.ts`, ADR 0007 §9–11), reached in the chat through the
`ChatCommands` interface.

Voice (ADR 0009, 0010) makes this model awkward: nobody dictates a slash. And the agent is already
the part that understands language. What it lacks is a way to *do* what Lotsman does:

- **Lotsman offers the agent no tools.** `session/new` carries `mcpServers`, but Lotsman fills it
  only from the user's own configuration (`requests.mcpServers`, the widget's MCP toggles) or
  passes `[]` (`start`, `resume`, `cancel`). Lotsman has no MCP server of its own.
- **Lotsman's client capabilities are closed on purpose.** `fs` and `terminal` are `false`
  (`LOTSMAN_CLIENT_CAPABILITIES`), and any other agent-to-client method is answered
  "method not found". An MCP server passed in `mcpServers` is therefore the only route by which
  the agent can call something of Lotsman's.
- **Permission handling is already strict.** `session/request_permission` fails closed (`denyAll`
  is the default gate); surfaces ask a person through `PermissionDesk`, one request at a time,
  and every path where nobody chose is `cancelled`. A host can mark tools it confirms itself
  (`host-tools.ts`). This covers the agent's *tool calls*, not a decision Lotsman's own actions
  need.
- **There is an action log, but it is not queryable.** `lotsman listen` appends ids and kinds to
  `listen.log` (`app/src/core/action-log.ts`), never message text. Nobody can ask it "what did you
  just do?", and it does not record which model saw what.

## Decision

1. **Language is the primary interface.** The person says or types what they want; the agent maps
   it to actions. Slash commands stay as **deterministic shortcuts**: they need no model call,
   work offline and can be tested exactly. They are no longer how a new user is taught to use
   Lotsman.
2. **Each command is one implementation, exposed twice.** The logic behind `/run`, `/tasks`,
   `/status` (and later further commands) stays in one function over plain data. It is exposed as
   the command and as an **agent tool**. Lotsman ships the tools as an MCP server,
   `lotsman mcp` (stdio, started by the agent as a child process), and adds it to the
   `mcpServers` of every session it opens. This is **new plumbing**: today no such server exists
   (see order of work, step 2). The server reuses the same functions the commands call; it adds
   no second copy of any rule.
3. **One confirmation rule for outward actions.** Before any action that leaves the machine or
   cannot be undone (send, call, delete, pay, run a task that does so), Lotsman reads the action
   back in plain words and waits for an explicit "yes". The rule lives in `@lotsman/core` as pure
   functions over plain data, next to `permission.ts`, and every frontend (window, widget,
   messenger, voice) renders it; none re-decides it. The tool server marks such tools, so the
   confirmation comes from Lotsman and not from the model's good manners. As with permissions,
   silence, a dismissal or an unclear answer is "no". In voice, only a closed answer counts
   (ADR 0010, point 3).
4. **An action log the person can query.** Every tool call and command writes one entry: what, when,
   from which surface, whether it left the machine, which model and provider received the
   content, and whether the person confirmed. Like today's log it keeps ids and kinds, not message
   bodies. A tool and a command, `/log`, answer "what did you just do?" and "did that leave the
   machine, and which model saw it?" from this record, not from the model's memory.
5. **Quiet by default.** Lotsman speaks or posts unprompted only for what the person asked for or
   must decide. One sentence ("be quiet", "mute notices") mutes the rest, and one sentence turns
   it back on. The setting is the person's, not the agent's.
6. **Say when uncertain.** When a request maps to more than one action, or the agent is not sure
   what is meant, it names the options and asks instead of guessing. The preamble Lotsman gives
   the agent says so; the confirmation rule (point 3) is the backstop where it matters.
7. **Content is data, never instruction.** Text from mail, messages, web pages or files can never
   trigger an action on its own. An action needs either a request from the person on a
   Lotsman surface or a task the person set up (ADR 0007). The tool server enforces it, not the
   preamble: a call that follows content from an untrusted source (a mail the agent just read) is
   confirmed even when it would otherwise not need to be, and the log records the source.
   Guardrail 1 still holds: nothing here is a stored permission.

## Consequences

- Voice and chat need no command vocabulary. A shortcut keeps its value: it is instant, free and
  works with no model or network. When the model is down or too slow, the commands are the
  fallback and nothing else changes.
- Every language request now costs a model call and its latency. For the short actions that voice
  makes frequent (status, run a task) this is slower and costlier than the command. The shortcuts
  stay so that a person who cares can skip it.
- A model may map a request to the wrong action. That is the reason for the confirmation rule,
  for "say when uncertain" and for the log, and it is why the first tools are read-only.
- Offering Lotsman's own MCP server enlarges what an agent can reach. It follows the existing
  rules: a profile or host can narrow the tool list, host-confirmed tools stay the host's, and
  `session/request_permission` still fails closed for the agent's calls.
- The confirmation rule and the action log are shared code, so the widget, window, messenger and
  voice surface cannot drift apart.
- Prompt injection is reduced by structure (point 7), not removed. A model can still be misled in
  what it *says*; it cannot, by content alone, make Lotsman act.
- The action log grows into a record of what the person did. It stays local, mode `0600`, and
  never leaves the machine.

## Order of work

1. **Commands as tools, in core.** Move the logic of `/run`, `/tasks`, `/status` behind one typed
   function each, tested without a model. The existing `task-commands.ts` split is the starting
   point; the tests prove the command and the tool return the same result.
2. **`lotsman mcp`.** A stdio MCP server exposing those functions as tools. Pass it in
   `mcpServers` for sessions the app opens (`start`, `resume`, the widget, requests). Needs the
   MCP server SDK on GJS ([gjsify#2389](https://github.com/gjsify/gjsify/issues/2389), as in ADR
   0008) or a small hand-written JSON-RPC server. Read-only tools first.
   *Done: hand-written (`packages/core/src/tool-server.ts`), tools `lotsman_status` and
   `lotsman_tasks`.*
   *Step 3 added `lotsman_run`. The stdio child cannot reach the confirmation book (it lives in the
   window's or `listen`'s memory), so the tool runs nothing: it checks the request, files it in a
   run inbox (`app/src/core/run-inbox.ts`) and answers "pending". The window or `listen` takes it,
   asks through the shared confirmation and runs the task only after a yes. A held-open call would
   race the person's answer against the agent's tool timeout. `/run` shares `confirmedRun`.*
3. **Shared confirmation.** The pure rule in core, then each surface renders it. The first
   outward tool (run a task that sends) gates on it.
   *Done: the rule and its three surfaces (see "Amendment: shared confirmation" below); `/run` as
   an agent tool is the next change.*
4. **Action log and its query.** Extend `listen.log` to every surface with the fields in point 4;
   add the `/log` command and the tool.
5. **Quiet mode and the untrusted-content boundary** in the tool server, with tests for a call
   that follows untrusted content.
6. **Spoken output.** Text to speech (ADR 0009) closes the loop with push to talk and
   conversation mode (ADR 0010): the person speaks, Lotsman reads back the confirmation, the
   person says "yes".

## Amendment: shared confirmation

Step 3 as built. The rule is `packages/core/src/confirmation.ts`; it is pure and has no GTK in it.

- **A confirmation** holds the action (kind, one sentence, labelled details such as the command and
  its directory or the recipient), a creation time and a scope: the window, or one chat. Its
  outcome is `approved`, `declined` or `expired` with a reason. `confirmThen` is the one door: it
  runs the action only on `approved`. There is no auto-approve and no default answer.
- **No time-based timeout.** A pending confirmation waits until it is answered. It expires when the
  situation it was asked in is gone: the person sent another message (`new-message`), cancelled
  the turn (`turn-cancelled`), the session or window ended (`session-ended`), or a different action
  was proposed in the same scope (`superseded`). The book is in memory only, so a restart resumes
  nothing; a stored card from an earlier run is drawn as expired (`restart`).
- **First answer wins, everywhere.** The answer closes the confirmation for every surface. A later
  answer changes nothing and is reported as already decided or expired.
- **Window.** A transcript card (`type: 'confirmation'` host line) with Yes and No, the exact
  action and its age. Neither button takes focus and nothing is the default. After the decision
  the card stays, marked approved, declined or expired, without buttons.
- **Chat.** The channel is text only (`sendToPeer` sends Markdown; no contract field offers
  buttons), so no button protocol is invented. The question is a message that says what will
  happen; "yes"/"ja" and "no"/"nein" (any case, trimmed) answer the single pending confirmation of
  that chat. Any other message expires it and is then handled as usual.
- **ACP permission requests stay on `PermissionDesk`.** They offer the agent's own option ids,
  can queue several at once and need an answer the agent understands (`selected` plus an id), none
  of which a yes/no carries. Folding them in would drop the agent's options or let one proposal
  supersede an unrelated tool call. Both follow the same rules (fail closed, no timeout, first
  answer wins); the window shows both as transcript or dialog, and a later change may route the
  desk's display through the card.
