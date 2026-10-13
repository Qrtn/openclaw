# Advisor (plugin)

Experimental and off by default. During user-directed work, Advisor reviews a
fork of the conversation on the session's own model. When it finds avoidable
work, such as drifting beyond the request or redundant tool calls, a second fork
checks the draft correction before any steering. Only approved advice reaches
the active run. Reviews preserve user-requested repetition,
waiting, ordering, and timing; uncertain cases receive no correction. Corrections
aim to fix the cause and resume useful work, not just stop at a recoverable
blocker. If the run cannot accept steering, the correction becomes hidden context
on the next turn and expires after 24 hours.

Review replies must start with `NO_CHANGE` or `CORRECTION` on its own line.
`NO_CHANGE` never starts verification or steering, even with commentary. A draft
correction is checked against the same session by a verifier, which replies
`APPROVE` with the final advice or `REJECT`. Only the approved body is delivered.
Both steps share a 120-second deadline. Advice is limited to 120 words and each
reply to 2,000 characters. Reserved decision words are not allowed as whole tokens
anywhere in either reply's body, including inline or next to punctuation.
Malformed replies, verification errors, and timeouts never steer; parser failures
log a bounded reason, and other failures log only a fixed category.

Enable it in **Settings → Agents & Tools → Labs → Advisor**. Its **Configure**
button opens the plugin's settings page. Or use config:

```json
{
  "plugins": {
    "entries": {
      "advisor": {
        "enabled": true,
        "config": { "everyToolCalls": 10, "everyMinutes": 20 }
      }
    }
  }
}
```

`everyToolCalls` counts tool calls as they start, including commands that are
still running in the background and calls from channel-originated user runs.
`everyMinutes` counts accumulated agent run time, including model work before the
first tool call, checked as tools start and when a run ends. Either trigger starts
a review; `0` disables a trigger. Both counters restart when a review completes,
including a failed review, so the next review waits a full interval.
Heartbeat, cron, memory-flush, overflow, and side-question runs do not count.

Reviews keep the session's model and context; there is no separate model setting.
The fork cannot execute tools, persist conversation messages, or send replies.
The plugin needs conversation access and prompt injection permission through
`plugins.entries.advisor.hooks` (the normal trusted-plugin defaults). At most one
review runs per session. Resetting the session, disabling the plugin, or stopping
its service cancels pending reviews, including verification. Gateway info logs
record each stage's token usage (input, cache reads/writes, and output) and elapsed
time, plus whether advice was steered or queued.

Docs: https://docs.openclaw.ai/concepts/experimental-features#advisor
