# Picture minutes from Tiro meetings

An agent skill (`SKILL.md`, name `mmx-meeting`) that turns a finished
[Tiro](https://tiro.ooo) meeting note into **picture minutes**: one Mermaid
diagram of topics, decisions, open questions, action items and their
evidence, which the human corrects on the picture with `mmx serve`. The
agent reads each correction as an edit to the minutes and keeps a text
version (`<slug>.minutes.md`) in step.

mmx does not depend on Tiro; this adapter only combines two CLIs.

## Setup

```bash
npm install -g @theplato/tiro-cli   # Tiro CLI
tiro auth login                     # once, in a browser; the token goes to the OS keychain
mmx init                            # mmx skill (0.4+)
```

Install the skill for your agent by copying this directory's `SKILL.md`:

```bash
mkdir -p ~/.claude/skills/mmx-meeting && cp adapters/tiro/SKILL.md ~/.claude/skills/mmx-meeting/   # Claude Code
mkdir -p ~/.codex/skills/mmx-meeting  && cp adapters/tiro/SKILL.md ~/.codex/skills/mmx-meeting/    # Codex
```

Then ask your agent, e.g. *"Make picture minutes of today's checkout sync
from Tiro."*, run `mmx serve <slug>.mmd`, and correct the picture.

## Example (synthetic)

`example/` holds an invented meeting so the format can be seen without a
Tiro account: the transcript in the shape `tiro notes transcript --format
json` returns, the drawn minutes (`checkout-sync.mmd`) and the text minutes
(`checkout-sync.minutes.md`).

```bash
cd adapters/tiro/example
mmx render checkout-sync.mmd --by agent --note "Draft minutes"
mmx serve checkout-sync.mmd
```

## Privacy

Meeting transcripts and minutes are the participants' data. Keep them out
of public repositories; the skill tells the agent to store fetched notes
outside the repository and never to handle Tiro API keys.
